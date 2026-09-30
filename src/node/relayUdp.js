'use strict';

const { normalizeLog } = require('../utils/log');

/**
 * UDP 侧中继（PROTOCOL.md §3.2）。
 *
 * 帧格式（隧道端口 UDP）：
 *   注册（Mod→节点，25s 保活）：[4B "LLKU"][1B 0x03][16B roomToken]
 *   数据（双向）：            [4B "LLKU"][1B 0x01][2B sessionId(大端)][payload]
 *   会话关闭（节点→Mod）：    [4B "LLKU"][1B 0x02][2B sessionId]
 *
 * 铁律（RESEARCH.md §2，ArcNet 按源地址路由）：
 * - 房间公网 UDP 端口收到未知源地址 → 分配 sessionId（uint16 递增，与该源地址
 *   绑定，2 分钟无流量过期）→ 封帧转给 Mod 注册的 UDP 地址；
 * - Mod 回程数据帧解封后必须**从房间公网 UDP socket** 发回对应客人源地址，
 *   保证客人视角源端口稳定。
 */

const dgram = require('dgram');

const MAGIC = Buffer.from('LLKU');
const TYPE_DATA = 0x01;
const TYPE_CLOSE = 0x02;
const TYPE_REGISTER = 0x03;

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}

function frame(type, sessionId, payload) {
  const head = Buffer.concat([MAGIC, Buffer.from([type]), u16(sessionId)]);
  return payload ? Buffer.concat([head, payload]) : head;
}

/**
 * 启动隧道端口 UDP socket（Mod 注册 + 回程数据帧）
 *
 * @param {{port:number, host?:string,
 *          resolveRoom:(tokenHex:string)=>object|null,
 *          roomByModAddr:Map<string, object>, log?:Console}} opts
 * @returns {Promise<{socket:import('dgram').Socket, close:()=>void}>}
 */
function startTunnelUdp({ port, host = '0.0.0.0', resolveRoom, roomByModAddr, log = console }) {
  log = normalizeLog(log);
  const socket = dgram.createSocket('udp4');
  socket.on('error', (err) => log.error('[relay-udp] tunnel socket error:', err.message));

  socket.on('message', (msg, rinfo) => {
    if (msg.length < 5 || !msg.subarray(0, 4).equals(MAGIC)) return;
    const type = msg[4];

    if (type === TYPE_REGISTER) {
      // [LLKU][0x03][16B roomToken]
      if (msg.length < 21) return;
      const tokenHex = msg.toString('hex', 5, 21);
      const room = resolveRoom(tokenHex);
      if (!room) return;
      const key = `${rinfo.address}:${rinfo.port}`;
      if (room.modUdpKey && room.modUdpKey !== key) roomByModAddr.delete(room.modUdpKey);
      const firstRegister = !room.modUdp;
      room.modUdp = { address: rinfo.address, port: rinfo.port, last: Date.now() };
      room.modUdpKey = key;
      roomByModAddr.set(key, room);
      if (firstRegister) log.info(`[relay-udp] ${room.code} 房主 UDP 已注册 (${key})`);
      return;
    }

    if (type === TYPE_DATA) {
      // Mod 回程帧：按源地址（Mod 注册的 UDP 地址）找到房间
      if (msg.length < 7) return;
      const room = roomByModAddr.get(`${rinfo.address}:${rinfo.port}`);
      if (!room || !room.udpSocket) return;
      room.modUdp.last = Date.now();
      const sessionId = msg.readUInt16BE(5);
      const sess = room.udpById.get(sessionId);
      if (!sess) return;
      sess.last = Date.now();
      const payload = msg.subarray(7);
      room.stats.tx += payload.length;
      // 必须从房间公网 UDP socket 发回，保证客人视角源端口稳定
      room.udpSocket.send(payload, sess.port, sess.address);
      return;
    }

    // 不认识的 type 丢弃（协议演进规则）
  });

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, () => {
      socket.removeListener('error', reject);
      resolve({
        socket,
        close() {
          try { socket.close(); } catch { /* ignore */ }
        }
      });
    });
  });
}

/** sessionId：uint16 从 1 递增，回绕并跳过在用 id */
function allocSessionId(room) {
  for (let i = 0; i < 65535; i++) {
    const id = room.nextSessionId;
    room.nextSessionId = room.nextSessionId >= 65535 ? 1 : room.nextSessionId + 1;
    if (!room.udpById.has(id)) return id;
  }
  return null;
}

/**
 * 启动房间公网 UDP socket（面向客人，原生游戏 UDP 包）
 *
 * @param {{room:object, port:number, host?:string,
 *          tunnelSocket:import('dgram').Socket,
 *          sessionTtlMs?:number, sweepMs?:number, log?:Console}} opts
 * @returns {Promise<{socket:import('dgram').Socket, close:()=>void}>}
 */
function openRoomUdp({ room, port, host = '0.0.0.0', tunnelSocket, sessionTtlMs = 120000, sweepMs = 10000, log = console }) {
  log = normalizeLog(log);
  const socket = dgram.createSocket('udp4');
  socket.on('error', (err) => log.error(`[relay-udp] room ${room.code} socket error:`, err.message));

  room.udpSocket = socket;
  room.udpSessions = new Map(); // "addr:port" -> session
  room.udpById = new Map();     // sessionId -> session
  room.nextSessionId = 1;

  socket.on('message', (msg, rinfo) => {
    // Mod 尚未注册 UDP 地址时无处可转，丢弃（游戏必需 UDP，静默丢弃会表现为客人"网络IO错误"）
    if (!room.modUdp) {
      if (!room.warnedNoModUdp) {
        room.warnedNoModUdp = true;
        log.warn(`[relay-udp] ${room.code} 收到客人 UDP 但房主 UDP 未注册，已丢弃 —— 客人将无法进房`);
      }
      return;
    }

    const key = `${rinfo.address}:${rinfo.port}`;
    let sess = room.udpSessions.get(key);
    if (!sess) {
      // 未知源地址 → 分配 sessionId 并绑定
      const id = allocSessionId(room);
      if (id == null) return;
      sess = { id, address: rinfo.address, port: rinfo.port, last: Date.now() };
      room.udpSessions.set(key, sess);
      room.udpById.set(id, sess);
      log.info(`[relay-udp] ${room.code} 客人 UDP 会话 ${id} 建立 (${key}) 首包 ${msg.length}B → mod ${room.modUdp.address}:${room.modUdp.port}`);
    }else{
      // 每 10 个包打一次进度，避免刷屏
      if(!sess.logCounter) sess.logCounter = 0;
      sess.logCounter++;
      if(sess.logCounter % 10 === 0){
        log.info(`[relay-udp] ${room.code} session ${sess.id} 持续转发中 (${key}) 累计 ${sess.logCounter} 包`);
      }
    }
    sess.last = Date.now();
    room.stats.rx += msg.length;
    tunnelSocket.send(frame(TYPE_DATA, sess.id, msg), room.modUdp.port, room.modUdp.address);
  });

  // 会话过期回收：2 分钟无流量，过期时向 Mod 发 [LLKU][0x02][sessionId]
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, sess] of room.udpSessions) {
      if (now - sess.last > sessionTtlMs) {
        room.udpSessions.delete(key);
        room.udpById.delete(sess.id);
        if (room.modUdp) {
          tunnelSocket.send(frame(TYPE_CLOSE, sess.id, null), room.modUdp.port, room.modUdp.address);
        }
      }
    }
  }, sweepMs);
  if (sweeper.unref) sweeper.unref();

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, () => {
      socket.removeListener('error', reject);
      resolve({
        socket,
        close() {
          clearInterval(sweeper);
          try { socket.close(); } catch { /* ignore */ }
          room.udpSocket = null;
          room.udpSessions.clear();
          room.udpById.clear();
        }
      });
    });
  });
}

module.exports = {
  startTunnelUdp,
  openRoomUdp,
  MAGIC,
  TYPE_DATA,
  TYPE_CLOSE,
  TYPE_REGISTER
};
