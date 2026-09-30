'use strict';

/**
 * fake-host —— 用 Node 实现的「Mod 侧」隧道协议参考实现（PROTOCOL.md §3）。
 *
 * M1 后半段真实 Mod（Java）会对照本文件调试，行为必须与协议逐字一致：
 * - 控制链：出站 TCP 连节点隧道端口，首帧 25 字节
 *   [4B "LLK1"][1B 0x01][16B roomToken 原始字节][4B connId=0]，
 *   之后换行分隔 JSON（new_conn / accept_conn / reject_conn / conn_closed / ping）
 * - 数据链：收到 new_conn 后另开 TCP 连隧道端口，首帧 type=0x02、connId=下发 id，
 *   握手后为裸字节流，与 127.0.0.1:gamePort 的本地连接对接
 * - UDP：一个「注册 socket」发 [LLKU][0x03][16B roomToken] 到隧道端口
 *   （25s 保活重发）；收到 [LLKU][0x01][2B sid][payload] 后，
 *   **每个 sessionId 一个独立本地 UDP socket** 与 127.0.0.1:gamePort 通信
 *   （ArcNet 按源地址路由，铁律，见 RESEARCH.md §2）；
 *   本地 socket 收到的回程包按 sid 封帧从注册 socket 发回节点；
 *   收到 [LLKU][0x02][2B sid] 关闭对应本地 socket。
 *
 * 事件：'new_conn'(msg) / 'conn_closed'(id) / 'session_closed'(sid)
 */

const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { once } = require('events');

const MAGIC_TCP = Buffer.from('LLK1');
const MAGIC_UDP = Buffer.from('LLKU');

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v, 0);
  return b;
}

/** 25 字节 TCP 隧道握手帧 */
function tcpHandshake(type, tokenRaw, connId) {
  const buf = Buffer.alloc(25);
  MAGIC_TCP.copy(buf, 0);
  buf[4] = type;
  tokenRaw.copy(buf, 5);
  buf.writeUInt32BE(connId >>> 0, 21);
  return buf;
}

class FakeHost extends EventEmitter {
  /**
   * @param {{nodeHost?:string, tunnelPort:number, roomToken:string,
   *          gamePort:number, autoAccept?:boolean, keepaliveMs?:number}} opts
   */
  constructor({ nodeHost = '127.0.0.1', tunnelPort, roomToken, gamePort, autoAccept = true, keepaliveMs = 25000 }) {
    super();
    this.nodeHost = nodeHost;
    this.tunnelPort = tunnelPort;
    this.tokenRaw = Buffer.from(roomToken, 'hex');
    if (this.tokenRaw.length !== 16) throw new Error('roomToken 必须是 32 字符 hex（16 字节）');
    this.gamePort = gamePort;
    this.autoAccept = autoAccept;
    this.keepaliveMs = keepaliveMs;

    this.control = null;
    this.udp = null;          // 注册/回程用的隧道 UDP socket
    this.regTimer = null;
    this.dataLinks = new Map(); // connId -> { data, local }
    this.sessions = new Map();  // sessionId -> { sock, ready, queue }
  }

  async start() {
    // ---- 控制链 ----
    this.control = net.connect(this.tunnelPort, this.nodeHost);
    this.control.setNoDelay(true);
    this.control.on('error', () => {});
    await once(this.control, 'connect');
    this.control.write(tcpHandshake(0x01, this.tokenRaw, 0));

    let lineBuf = '';
    this.control.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      let idx;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.handleControl(msg);
      }
    });

    // ---- 隧道 UDP：注册 + 数据帧 ----
    this.udp = dgram.createSocket('udp4');
    this.udp.on('error', () => {});
    await new Promise((resolve) => this.udp.bind(0, '127.0.0.1', resolve));
    this.udp.on('message', (msg) => this.handleUdp(msg));
    this.register();
    this.regTimer = setInterval(() => this.register(), this.keepaliveMs);
    if (this.regTimer.unref) this.regTimer.unref();
  }

  /** UDP 注册帧（建立会话后每 25s 重发保活 NAT） */
  register() {
    const frame = Buffer.concat([MAGIC_UDP, Buffer.from([0x03]), this.tokenRaw]);
    this.udp.send(frame, this.tunnelPort, this.nodeHost);
  }

  sendControl(obj) {
    if (this.control && !this.control.destroyed) {
      this.control.write(JSON.stringify(obj) + '\n');
    }
  }

  handleControl(msg) {
    switch (msg.op) {
      case 'new_conn':
        this.emit('new_conn', msg);
        if (this.autoAccept) {
          // 关闭审批时 Mod 自动立刻回 accept_conn，并打开数据链
          this.sendControl({ op: 'accept_conn', id: msg.id });
          this.openDataLink(msg.id);
        }
        break;
      case 'conn_closed': {
        const link = this.dataLinks.get(msg.id);
        if (link) {
          link.data.destroy();
          link.local.destroy();
          this.dataLinks.delete(msg.id);
        }
        this.emit('conn_closed', msg.id);
        break;
      }
      case 'ping':
        this.sendControl({ op: 'pong' });
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  /** 数据链：隧道端 type=0x02 握手 + 本地游戏连接，双向 splice */
  openDataLink(id) {
    const data = net.connect(this.tunnelPort, this.nodeHost);
    data.setNoDelay(true);
    data.on('error', () => {});
    const local = net.connect(this.gamePort, '127.0.0.1');
    local.setNoDelay(true);
    local.on('error', () => {});

    this.dataLinks.set(id, { data, local });

    let dataReady = false;
    let localReady = false;
    const maybeSplice = () => {
      if (dataReady && localReady) {
        data.pipe(local);
        local.pipe(data);
      }
    };
    data.once('connect', () => {
      data.write(tcpHandshake(0x02, this.tokenRaw, id));
      dataReady = true;
      maybeSplice();
    });
    local.once('connect', () => {
      localReady = true;
      maybeSplice();
    });

    const closeBoth = () => {
      data.destroy();
      local.destroy();
      this.dataLinks.delete(id);
    };
    data.once('close', closeBoth);
    local.once('close', closeBoth);
  }

  handleUdp(msg) {
    if (msg.length < 5 || !msg.subarray(0, 4).equals(MAGIC_UDP)) return;
    const type = msg[4];

    if (type === 0x01) {
      if (msg.length < 7) return;
      const sid = msg.readUInt16BE(5);
      const payload = msg.subarray(7);
      this.forwardToGame(sid, payload);
    } else if (type === 0x02) {
      if (msg.length < 7) return;
      const sid = msg.readUInt16BE(5);
      const sess = this.sessions.get(sid);
      if (sess) {
        try { sess.sock.close(); } catch { /* ignore */ }
        this.sessions.delete(sid);
      }
      this.emit('session_closed', sid);
    }
  }

  /** 每个 sessionId 一个独立本地 UDP socket（防串包铁律） */
  forwardToGame(sid, payload) {
    let sess = this.sessions.get(sid);
    if (!sess) {
      const sock = dgram.createSocket('udp4');
      sess = { sock, ready: false, queue: [] };
      this.sessions.set(sid, sess);
      sock.on('error', () => {});
      // 本地 socket 收到的回程包按 sessionId 封帧发回节点（从注册 socket 发）
      sock.on('message', (reply) => {
        const frame = Buffer.concat([MAGIC_UDP, Buffer.from([0x01]), u16(sid), reply]);
        this.udp.send(frame, this.tunnelPort, this.nodeHost);
      });
      sock.bind(0, '127.0.0.1', () => {
        sess.ready = true;
        for (const p of sess.queue) sock.send(p, this.gamePort, '127.0.0.1');
        sess.queue.length = 0;
      });
    }
    if (sess.ready) sess.sock.send(payload, this.gamePort, '127.0.0.1');
    else sess.queue.push(payload);
  }

  close() {
    if (this.regTimer) clearInterval(this.regTimer);
    if (this.control) {
      try { this.control.destroy(); } catch { /* ignore */ }
    }
    for (const { data, local } of this.dataLinks.values()) {
      data.destroy();
      local.destroy();
    }
    this.dataLinks.clear();
    for (const sess of this.sessions.values()) {
      try { sess.sock.close(); } catch { /* ignore */ }
    }
    this.sessions.clear();
    if (this.udp) {
      try { this.udp.close(); } catch { /* ignore */ }
    }
  }
}

module.exports = { FakeHost, tcpHandshake, MAGIC_TCP, MAGIC_UDP };
