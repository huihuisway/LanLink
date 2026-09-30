'use strict';

/**
 * LanLink 边缘节点（独立进程）。
 *
 * 两部分：
 * - createRelay：纯数据面（隧道端口 TCP+UDP、房间公网端口、端口池），
 *   不依赖 WS/数据库，tests/tunnel.test.js 直接进程内使用；
 * - startAgent：WS 控制客户端，只通过 WS 连控制面（register / heartbeat /
 *   open_room / close_room / room_stat），掉线指数退避重连，重连成功后重新
 *   register——房间状态以控制面为准（控制面重发 open_room，openRoom 幂等）。
 */

const fs = require('fs');
const path = require('path');
const { createPortPool } = require('./portPool');
const relayTcp = require('./relayTcp');
const relayUdp = require('./relayUdp');

/**
 * 创建节点数据面
 *
 * @param {{tunnelPort:number, portRanges:Array<{min:number, max:number}>, bindHost?:string,
 *          acceptTimeoutMs?:number, udpSessionTtlMs?:number, udpSweepMs?:number,
 *          log?:Console}} opts
 */
async function createRelay({
  tunnelPort,
  portRanges,
  bindHost = '0.0.0.0',
  acceptTimeoutMs = 10000,
  udpSessionTtlMs = 120000,
  udpSweepMs = 10000,
  log = console
}) {
  const rooms = new Map();         // code -> room
  const byToken = new Map();       // roomToken(hex) -> room
  const roomByModAddr = new Map(); // "addr:port"(Mod 注册的 UDP 地址) -> room
  const pool = createPortPool({ ranges: portRanges, host: bindHost });

  const resolveRoom = (tokenHex) => byToken.get(tokenHex) || null;

  // 隧道端口：一个 TCP listener（控制链 + 数据链握手分流）+ 一个 UDP socket
  const tunnelTcp = await relayTcp.startTunnelTcp({ port: tunnelPort, host: bindHost, resolveRoom, log });
  const tunnelUdp = await relayUdp.startTunnelUdp({ port: tunnelPort, host: bindHost, resolveRoom, roomByModAddr, log });

  /**
   * 开房（幂等：已开的房间直接回报既有端口）
   * @param {{code:string, roomToken:string}} param0
   * @returns {Promise<{roomPort:number}>}
   */
  async function openRoom({ code, roomToken }) {
    const existing = rooms.get(code);
    if (existing) return { roomPort: existing.port };

    const port = await pool.acquire();
    const room = {
      code,
      tokenHex: String(roomToken).toLowerCase(),
      port,
      control: null,
      pending: new Map(),
      conns: new Map(),
      nextConnId: 1,
      modUdp: null,
      modUdpKey: null,
      udpSocket: null,
      udpSessions: new Map(),
      udpById: new Map(),
      nextSessionId: 1,
      tcpServer: null,
      udpHandle: null,
      stats: { rx: 0, tx: 0 },
      log
    };

    try {
      room.tcpServer = await relayTcp.openRoomTcp({ room, port, host: bindHost, acceptTimeoutMs, log });
      room.udpHandle = await relayUdp.openRoomUdp({
        room, port, host: bindHost,
        tunnelSocket: tunnelUdp.socket,
        sessionTtlMs: udpSessionTtlMs,
        sweepMs: udpSweepMs,
        log
      });
    } catch (err) {
      if (room.tcpServer) room.tcpServer.close();
      if (room.udpHandle) room.udpHandle.close();
      pool.release(port);
      throw err;
    }

    rooms.set(code, room);
    byToken.set(room.tokenHex, room);
    log.log(`[relay] room ${code} opened on port ${port}`);
    return { roomPort: port };
  }

  /** 关房：断开所有连接、关闭监听、回收端口 */
  function closeRoom(code) {
    const room = rooms.get(code);
    if (!room) return;
    rooms.delete(code);
    byToken.delete(room.tokenHex);
    if (room.modUdpKey) roomByModAddr.delete(room.modUdpKey);
    relayTcp.destroyRoomTcp(room);
    if (room.udpHandle) room.udpHandle.close();
    pool.release(room.port);
    log.log(`[relay] room ${code} closed, port ${room.port} released`);
  }

  /** 各房间累计流量/连接数（room_stat 上报用，rx/tx 为累计字节数） */
  function roomStats() {
    return [...rooms.values()].map((r) => ({
      code: r.code,
      conns: r.conns.size,
      rx: r.stats.rx,
      tx: r.stats.tx
    }));
  }

  /** 会话总数（TCP 在途连接 + UDP 活跃会话） */
  function sessionCount() {
    let n = 0;
    for (const r of rooms.values()) n += r.conns.size + r.udpById.size;
    return n;
  }

  async function close() {
    for (const code of [...rooms.keys()]) closeRoom(code);
    tunnelTcp.close();
    tunnelUdp.close();
  }

  return { openRoom, closeRoom, roomStats, sessionCount, rooms, close };
}

/**
 * 解析 PORT_RANGE 环境变量为排序后的 [min, max] 对数组。
 *
 * 支持格式：
 *   "20001-20099"                   → [[20001, 20099]]
 *   "20001-20099,30001-30099"       → [[20001, 20099], [30001, 30099]]
 *
 * @param {string} raw
 * @returns {number[][]} 按起始端口排序的 [min, max] 对数组
 */
function parsePortRanges(raw) {
  if (!raw || !raw.trim()) throw new Error('PORT_RANGE 为空');

  const ranges = [];
  for (const token of raw.split(',')) {
    const t = token.trim();
    if (!t) throw new Error(`PORT_RANGE 含空段: "${raw}"`);

    const parts = t.split('-');
    if (parts.length !== 2) throw new Error(`PORT_RANGE 范围格式错误: "${t}"（需为 min-max）`);

    const lo = parseInt(parts[0].trim(), 10);
    const hi = parseInt(parts[1].trim(), 10);

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`PORT_RANGE 含非整数: "${t}"`);
    }
    if (lo < 1 || lo > 65535 || hi < 1 || hi > 65535) {
      throw new Error(`PORT_RANGE 端口越界(1-65535): "${t}"`);
    }
    if (lo > hi) {
      throw new Error(`PORT_RANGE min > max: "${t}"`);
    }

    ranges.push({ min: lo, max: hi });
  }

  if (ranges.length === 0) throw new Error('PORT_RANGE 为空');

  // 按起始端口排序，保证分配顺序确定
  ranges.sort((a, b) => a.min - b.min);
  return ranges;
}

/** 从 node.env（或 .env）读取节点配置 */
function loadNodeConfig() {
  const envFile = process.env.LANLINK_NODE_ENV
    || (fs.existsSync(path.join(process.cwd(), 'node.env')) ? path.join(process.cwd(), 'node.env') : null);
  if (envFile) require('dotenv').config({ path: envFile });
  else require('dotenv').config();

  const portRanges = parsePortRanges(process.env.PORT_RANGE || '20001-20099');

  // PUBLIC_ADDR 是下发给房主与客人的地址。回环地址只对本机有意义，
  // 其他设备拿到后会连向它们自己 —— 表现为客人侧「网络 IO 错误」。
  const publicAddr = process.env.PUBLIC_ADDR || '127.0.0.1';
  if (publicAddr === '127.0.0.1' || publicAddr === 'localhost' || publicAddr === '::1') {
    console.warn(
      `[agent] 警告：PUBLIC_ADDR=${publicAddr} 是回环地址，只有本机能连上。\n`
      + '        局域网测试请填本机内网 IP，公网使用请填服务器公网 IP。'
    );
  }

  const tunnelPort = parseInt(process.env.TUNNEL_PORT) || 20000;

  // 校验隧道端口不与端口池重叠
  for (const { min, max } of portRanges) {
    if (tunnelPort >= min && tunnelPort <= max) {
      throw new Error(`TUNNEL_PORT(${tunnelPort}) 与 PORT_RANGE(${min}-${max}) 冲突`);
    }
  }

  return {
    controlUrl: process.env.CONTROL_URL || 'ws://127.0.0.1:5100/ws/node',
    nodeToken: process.env.NODE_TOKEN || '',
    nodeName: process.env.NODE_NAME || '',
    publicAddr,
    tunnelPort,
    portRanges,
    mbpsLimit: parseFloat(process.env.MBPS_LIMIT) || 30,
    heartbeatMs: parseInt(process.env.HEARTBEAT_MS) || 10000,
    requiresLogin: process.env.REQUIRES_LOGIN === 'true'
  };
}

/**
 * 启动节点：连控制面 WS，注册、心跳、处理开关房指令。
 * 掉线指数退避重连（1s 起，封顶 30s）。
 */
function startAgent(cfg, { log = console } = {}) {
  const WebSocket = require('ws');
  const startTime = Date.now();

  let relay = null;
  let ws = null;
  let heartbeatTimer = null;
  let attempt = 0;
  let stopped = false;
  let mbpsSample = { total: 0, at: Date.now() };

  log.log(`[agent] 控制面: ${cfg.controlUrl} | 节点: ${cfg.nodeName || '(未命名)'} | 公网: ${cfg.publicAddr}`);
  const rangeDesc = cfg.portRanges.map((r) => `${r.min}-${r.max}`).join(',');
  log.log(`[agent] 隧道端口: ${cfg.tunnelPort} | 端口池: ${rangeDesc}`);
  log.log(`[agent] 启动数据面（绑定端口）...`);

  const relayReady = createRelay({
    tunnelPort: cfg.tunnelPort,
    portRanges: cfg.portRanges,
    log
  }).then((r) => {
    relay = r;
    log.log(`[agent] 数据面就绪（${Date.now() - startTime}ms）`);
    return r;
  });
  relayReady.catch((err) => {
    log.error('[agent] 数据面启动失败:', err.message);
    process.exitCode = 1;
  });

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function computeMbps(stats) {
    const total = stats.reduce((s, r) => s + r.rx + r.tx, 0);
    const now = Date.now();
    const seconds = (now - mbpsSample.at) / 1000;
    const mbps = seconds > 0 ? ((total - mbpsSample.total) * 8) / 1e6 / seconds : 0;
    mbpsSample = { total, at: now };
    return Math.max(0, Math.round(mbps * 100) / 100);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!relay) {
        send({ op: 'heartbeat', rooms: 0, sessions: 0, mbps_used: 0 });
        return;
      }
      const stats = relay.roomStats();
      // room_stat 随心跳批量上报（控制面收到 heartbeat 时批量落库）
      for (const s of stats) {
        send({ op: 'room_stat', code: s.code, conns: s.conns, rx: s.rx, tx: s.tx });
      }
      send({
        op: 'heartbeat',
        rooms: stats.length,
        sessions: relay.sessionCount(),
        mbps_used: computeMbps(stats)
      });
    }, cfg.heartbeatMs || 10000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(1000 * 2 ** attempt, 30000);
    attempt++;
    log.log(`[agent] ${delay}ms 后重连控制面...`);
    const t = setTimeout(connect, delay);
    if (t.unref) t.unref();
  }

  function connect() {
    if (stopped) return;
    log.log(`[agent] 连接控制面 ${cfg.controlUrl} ...`);
    const connectStart = Date.now();
    ws = new WebSocket(cfg.controlUrl);

    ws.on('open', () => {
      attempt = 0;
      log.log(`[agent] 已连接（${Date.now() - connectStart}ms），发送注册...`);
      send({
        op: 'register',
        ver: 1,
        token: cfg.nodeToken,
        name: cfg.nodeName,
        addr: cfg.publicAddr,
        tunnel_port: cfg.tunnelPort,
        port_range: cfg.portRanges.map((r) => [r.min, r.max]),
        mbps: cfg.mbpsLimit,
        requires_login: cfg.requiresLogin
      });
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        switch (msg.op) {
          case 'register_ok':
            log.log(`[agent] registered as ${msg.id}（启动总耗时 ${Date.now() - startTime}ms）`);
            startHeartbeat();
            break;
          case 'open_room': {
            const r = await relayReady;
            const { roomPort } = await r.openRoom({ code: msg.code, roomToken: msg.room_token });
            send({ op: 'room_opened', code: msg.code, room_port: roomPort });
            break;
          }
          case 'close_room':
            if (relay) relay.closeRoom(msg.code);
            break;
          case 'ping':
            send({ op: 'pong' });
            break;
          case 'pong':
            break;
          case 'error':
            log.error('[agent] control error:', msg.code, msg.msg);
            break;
          default:
            break;
        }
      } catch (err) {
        log.error(`[agent] 处理 ${msg.op} 失败:`, err.message);
      }
    });

    ws.on('close', () => {
      log.log(`[agent] 控制面连接断开`);
      stopHeartbeat();
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      log.error('[agent] ws error:', err.message);
    });
  }

  connect();

  return {
    async stop() {
      stopped = true;
      stopHeartbeat();
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
      }
      if (relay) await relay.close();
    }
  };
}

if (require.main === module) {
  console.log('[agent] 加载配置...');
  const cfg = loadNodeConfig();
  if (!cfg.nodeToken) {
    console.error('NODE_TOKEN 未配置（node.env）');
    process.exit(1);
  }
  const agent = startAgent(cfg);

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down node agent...`);
    await agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createRelay, startAgent, loadNodeConfig, parsePortRanges };
