'use strict';

const { normalizeLog } = require('../utils/log');

/**
 * TCP 侧中继（PROTOCOL.md §3.1）。
 *
 * 隧道端口 TCP listener：Mod 出站连接，首帧固定 25 字节
 *   [4B magic "LLK1"][1B type][16B roomToken(原始字节)][4B connId(大端)]
 *   type 0x01 = 控制链（connId=0，每房间恒一条，换行分隔 JSON）
 *   type 0x02 = 数据链（connId = new_conn 下发的 id，握手后为裸字节流）
 *
 * 房间公网端口 TCP listener：客人接入 → 经控制链发 new_conn{id,addr} →
 * 等 accept_conn + 数据链 → splice；10s 超时断开客人；conn_closed 通知。
 */

const net = require('net');

const MAGIC = 'LLK1';
const HANDSHAKE_LEN = 25;
const TYPE_CONTROL = 0x01;
const TYPE_DATA = 0x02;

/** 向房间控制链发送一条换行分隔 JSON */
function sendControl(room, obj) {
  if (room.control && !room.control.destroyed && room.control.writable) {
    room.control.write(JSON.stringify(obj) + '\n');
  }
}

/**
 * 启动隧道端口 TCP listener（控制链 + 数据链握手分流）
 * @param {{port:number, host?:string, resolveRoom:(tokenHex:string)=>object|null,
 *          handshakeTimeoutMs?:number, log?:Console}} opts
 * @returns {Promise<net.Server>}
 */
function startTunnelTcp({ port, host = '0.0.0.0', resolveRoom, handshakeTimeoutMs = 10000, log = console }) {
  log = normalizeLog(log);
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => {});

    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), handshakeTimeoutMs);
    if (timer.unref) timer.unref();
    socket.once('close', () => clearTimeout(timer));

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < HANDSHAKE_LEN) return;
      socket.removeListener('data', onData);
      clearTimeout(timer);

      const magic = buf.toString('latin1', 0, 4);
      const type = buf[4];
      const tokenHex = buf.toString('hex', 5, 21);
      const connId = buf.readUInt32BE(21);
      const rest = buf.subarray(HANDSHAKE_LEN);

      // roomToken 校验失败立即断开
      const room = magic === MAGIC ? resolveRoom(tokenHex) : null;
      if (!room) {
        socket.destroy();
        return;
      }

      if (type === TYPE_CONTROL) {
        attachControlLink(room, socket, rest, log);
      } else if (type === TYPE_DATA) {
        attachDataLink(room, socket, connId, rest);
      } else {
        socket.destroy();
      }
    };
    socket.on('data', onData);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/** 控制链：每房间恒一条，换行分隔 JSON */
function attachControlLink(room, socket, rest, log) {
  if (room.control && room.control !== socket) {
    try { room.control.destroy(); } catch { /* ignore */ }
  }
  room.control = socket;

  let lineBuf = '';
  const feed = (chunk) => {
    lineBuf += chunk.toString('utf8');
    let idx;
    while ((idx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (line) handleControlLine(room, line, log);
    }
  };
  socket.on('data', feed);
  if (rest.length > 0) feed(rest);

  socket.once('close', () => {
    if (room.control === socket) room.control = null;
  });
}

function handleControlLine(room, line, log) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.op) {
    case 'accept_conn': {
      const pending = room.pending.get(msg.id);
      if (pending) {
        pending.accepted = true;
        trySplice(room, msg.id);
      }
      break;
    }
    case 'reject_conn':
      closePending(room, msg.id, false);
      break;
    case 'ping':
      sendControl(room, { op: 'pong' });
      break;
    case 'pong':
      break;
    default:
      // 不认识的操作忽略（协议演进规则：收端忽略未知字段/操作）
      break;
  }
}

/** 数据链：握手帧之后即为裸字节流，与对应客人 TCP 连接对接 */
function attachDataLink(room, socket, connId, rest) {
  const pending = room.pending.get(connId);
  if (!pending || pending.dataLink) {
    socket.destroy();
    return;
  }
  socket.pause(); // splice 之前不消费数据（内核缓冲）
  pending.dataLink = socket;
  pending.dataRest = rest.length > 0 ? rest : null;
  socket.once('close', () => {
    if (!pending.spliced) closePending(room, connId, true);
  });
  trySplice(room, connId);
}

/**
 * 启动房间公网端口 TCP listener
 * @param {{room:object, port:number, host?:string, acceptTimeoutMs?:number, log?:Console}} opts
 * @returns {Promise<net.Server>}
 */
function openRoomTcp({ room, port, host = '0.0.0.0', acceptTimeoutMs = 10000, log = console }) {
  log = normalizeLog(log);
  const server = net.createServer((guest) => {
    guest.setNoDelay(true);
    guest.on('error', () => {});

    // 控制链不在（Mod 未连或已断）时无法转发，直接断开客人
    if (!room.control || room.control.destroyed) {
      log.warn(`[relay-tcp] ${room.code} 客人 ${guest.remoteAddress} 接入被拒：房主控制链未连接`);
      guest.destroy();
      return;
    }

    const id = room.nextConnId++;
    log.info(`[relay-tcp] ${room.code} 客人 ${guest.remoteAddress}:${guest.remotePort} 接入 (conn ${id})`);
    const timer = setTimeout(() => closePending(room, id, true), acceptTimeoutMs);
    if (timer.unref) timer.unref();

    const pending = { id, guest, timer, accepted: false, dataLink: null, dataRest: null, spliced: false, closed: false };
    room.pending.set(id, pending);

    guest.once('close', () => {
      if (!pending.spliced) closePending(room, id, true);
    });

    sendControl(room, { op: 'new_conn', id, addr: `${guest.remoteAddress}:${guest.remotePort}` });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/** accept + 数据链都就绪后对接（splice）客人连接与数据链 */
function trySplice(room, id) {
  const p = room.pending.get(id);
  if (!p || !p.accepted || !p.dataLink) return;

  clearTimeout(p.timer);
  room.pending.delete(id);
  p.spliced = true;
  room.conns.set(id, p);
  normalizeLog(room.log).info(`[relay-tcp] ${room.code} conn ${id} 已对接（客人 ↔ 房主数据链）`);

  const { guest, dataLink } = p;

  // 流量统计（额外 data 监听不影响 pipe 的背压）
  guest.on('data', (c) => { room.stats.rx += c.length; });
  dataLink.on('data', (c) => { room.stats.tx += c.length; });

  // Mod 在握手帧后立即发出的字节先转给客人，保持顺序
  if (p.dataRest && p.dataRest.length > 0) {
    room.stats.tx += p.dataRest.length;
    guest.write(p.dataRest);
    p.dataRest = null;
  }

  guest.pipe(dataLink);
  dataLink.pipe(guest);

  // 任一端关闭即双向关闭 + conn_closed 通知
  const closeBoth = () => {
    if (p.closed) return;
    p.closed = true;
    room.conns.delete(id);
    guest.destroy();
    dataLink.destroy();
    sendControl(room, { op: 'conn_closed', id });
  };
  guest.once('close', closeBoth);
  dataLink.once('close', closeBoth);
}

/** 挂起连接清理（超时 / 拒绝 / 客人提前断开） */
function closePending(room, id, notify) {
  const p = room.pending.get(id);
  if (!p) return;
  room.pending.delete(id);
  clearTimeout(p.timer);
  p.closed = true;
  try { p.guest.destroy(); } catch { /* ignore */ }
  if (p.dataLink) {
    try { p.dataLink.destroy(); } catch { /* ignore */ }
  }
  if (notify) sendControl(room, { op: 'conn_closed', id });
}

/** 房间关闭：断开所有挂起/在途连接、控制链，停止公网 TCP listener */
function destroyRoomTcp(room) {
  for (const id of [...room.pending.keys()]) {
    closePending(room, id, false);
  }
  for (const [id, p] of [...room.conns]) {
    p.closed = true;
    room.conns.delete(id);
    try { p.guest.destroy(); } catch { /* ignore */ }
    try { p.dataLink.destroy(); } catch { /* ignore */ }
  }
  if (room.control) {
    try { room.control.destroy(); } catch { /* ignore */ }
    room.control = null;
  }
  if (room.tcpServer) {
    room.tcpServer.close();
    room.tcpServer = null;
  }
}

module.exports = {
  startTunnelTcp,
  openRoomTcp,
  destroyRoomTcp,
  sendControl,
  MAGIC,
  HANDSHAKE_LEN,
  TYPE_CONTROL,
  TYPE_DATA
};
