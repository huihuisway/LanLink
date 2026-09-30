'use strict';

const { sanitizeLabelPart } = require('./displayName');

/**
 * 归一化 port_range：旧节点发扁平二元组 [min, max]，新节点发 [[min,max], ...]。
 * 统一存为数组格式，仅用于诊断，不参与调度。
 */
function normalizePortRange(raw) {
  if (!raw || !Array.isArray(raw)) return null;
  // 旧格式：[20001, 20099]
  if (raw.length === 2 && Number.isInteger(raw[0]) && Number.isInteger(raw[1])) {
    return [[raw[0], raw[1]]];
  }
  // 新格式：[[20001, 20099], [30001, 30099]]
  if (Array.isArray(raw[0])) return raw;
  return null;
}

/**
 * 节点 ↔ 控制面网关（/ws/node，PROTOCOL.md §2）。
 *
 * - register 校验 tokenMap（优先）或 tokens 白名单（兼容）
 * - tokenMap 为 Map<token, {id, name, owner, official, region, tags, description}>
 * - 旧模式 tokens = []：第 i 个 token 对应节点 id `node-{i+1}`，official=true
 * - 注册表存内存 Map + Redis lanlink:node:{id}（TTL 30s，心跳刷新，经 persistence 注入）
 * - 心跳超时（默认 30s）摘除节点并销毁其上房间（reason=node_down）
 * - room_stat 缓冲，收到 heartbeat 时批量写 MySQL bandwidth_logs
 *
 * persistence 接口（全部可选）：
 *   saveNode(id, info) / refreshNode(id) / deleteNode(id) / writeBandwidth(rows)
 */
function createNodeGateway({
  wss,
  tokens = [],
  tokenMap = null,
  registry,
  persistence = null,
  heartbeatTimeoutMs = 30000,
  sweepMs = 5000,
  openTimeoutMs = 10000,
  log = console
}) {
  const nodes = new Map();        // id -> { id, ws, addr, tunnelPort, portRange, mbps, stats, lastSeen, connected, owner, official, region, tags, description }
  const pendingOpens = new Map(); // code -> { resolve, reject }
  let statBuffer = [];            // 心跳之间累积的 room_stat 行

  // 统一 token registry：tokenMap 优先，tokens 数组作为 fallback
  const allTokens = new Map();
  if (tokenMap) {
    for (const [k, v] of tokenMap) allTokens.set(k, { ...v });
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!allTokens.has(t)) {
      allTokens.set(t, {
        token: t,
        id: `node-${i + 1}`,
        name: `节点 ${i + 1}`,
        owner: '',
        official: true,
        region: '',
        tags: [],
        description: '',
        createdAt: 0
      });
    }
  }

  function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function fireAndForget(fn, args, what) {
    if (!persistence || typeof persistence[fn] !== 'function') return;
    Promise.resolve(persistence[fn](...args)).catch((err) => {
      log.error(`[node] ${what} failed:`, err && err.message);
    });
  }

  wss.on('connection', (ws) => {
    let node = null;
    ws.on('error', () => {});

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        send(ws, { op: 'error', code: 'invalid_op', msg: '消息不是合法 JSON' });
        return;
      }

      switch (msg.op) {
        case 'register': {
          const info = typeof msg.token === 'string' ? allTokens.get(msg.token) : null;
          if (!info) {
            send(ws, { op: 'error', code: 'auth_failed', msg: '节点 token 无效' });
            ws.close();
            return;
          }
          const id = info.id;
          const nodeName = sanitizeLabelPart(msg.name, id, 32);
          const existing = nodes.get(id);
          if (existing && existing.ws !== ws) {
            try { existing.ws.close(); } catch { /* ignore */ }
          }
          node = {
            id,
            name: nodeName,
            ws,
            addr: msg.addr || '',
            tunnelPort: msg.tunnel_port || 0,
            portRange: normalizePortRange(msg.port_range),
            mbps: msg.mbps || 0,
            stats: { rooms: 0, sessions: 0, mbpsUsed: 0 },
            lastSeen: Date.now(),
            connected: true,
            owner: info.owner || '',
            official: info.official !== false,
            region: msg.region || info.region || '',
            tags: Array.isArray(info.tags) ? info.tags.slice() : [],
            description: msg.description || info.description || '',
            requiresLogin: msg.requires_login === true
          };
          nodes.set(id, node);
          fireAndForget('saveNode', [id, node], 'saveNode');
          send(ws, { op: 'register_ok', id, official: node.official });
          // 房间状态以控制面为准：节点重连后，把控制面认为仍在该节点上的房间
          // 重新下发 open_room（节点侧幂等处理，已开的房间回报既有端口）
          for (const room of registry.roomsOnNode(id)) {
            send(ws, { op: 'open_room', code: room.code, room_token: room.roomToken });
          }
          break;
        }

        case 'heartbeat': {
          if (!node) return send(ws, { op: 'error', code: 'invalid_op', msg: '未注册' });
          node.lastSeen = Date.now();
          node.stats = {
            rooms: msg.rooms || 0,
            sessions: msg.sessions || 0,
            mbpsUsed: msg.mbps_used || 0
          };
          fireAndForget('saveNode', [node.id, node], 'saveNode');
          flushStats();
          break;
        }

        case 'room_opened': {
          if (!node) return;
          registry.setRoomPort(msg.code, msg.room_port);
          const pending = pendingOpens.get(msg.code);
          if (pending) {
            pendingOpens.delete(msg.code);
            pending.resolve({ roomPort: msg.room_port });
          }
          break;
        }

        case 'room_stat': {
          if (!node) return;
          statBuffer.push({
            nodeId: node.id,
            code: msg.code,
            conns: msg.conns || 0,
            rx: msg.rx || 0,
            tx: msg.tx || 0
          });
          break;
        }

        case 'ping':
          send(ws, { op: 'pong' });
          break;

        case 'pong':
          break;

        default:
          send(ws, { op: 'error', code: 'invalid_op', msg: `未知操作: ${msg.op}` });
      }
    });

    ws.on('close', () => {
      // 不立即摘除：节点可能在指数退避后重连；30s 无心跳由 sweeper 兜底摘除
      if (node) node.connected = false;
    });
  });

  /** 心跳到达时把缓冲的 room_stat 批量落库 */
  function flushStats() {
    if (statBuffer.length === 0) return;
    const rows = statBuffer;
    statBuffer = [];
    fireAndForget('writeBandwidth', [rows], 'writeBandwidth');
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, n] of nodes) {
      if (now - n.lastSeen > heartbeatTimeoutMs) {
        log.warn(`[node] ${id} 心跳超时，摘除并销毁其上房间`);
        removeNode(id, 'node_down');
      }
    }
  }, sweepMs);
  if (sweeper.unref) sweeper.unref();

  /** 摘除节点并销毁其上所有房间 */
  function removeNode(id, reason) {
    const n = nodes.get(id);
    if (!n) return;
    nodes.delete(id);
    try { n.ws.close(); } catch { /* ignore */ }
    fireAndForget('deleteNode', [id], 'deleteNode');
    for (const room of registry.roomsOnNode(id)) {
      registry.destroyRoom(room.code, reason);
    }
  }

  /**
   * 让节点开房；room_opened 回来后 resolve {roomPort}
   * @param {string} nodeId
   * @param {{code:string, roomToken:string}} room
   */
  function openRoom(nodeId, room) {
    const n = nodes.get(nodeId);
    if (!n || !n.connected) return Promise.reject(new Error('节点不在线'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingOpens.delete(room.code);
        reject(new Error('open_room 超时'));
      }, openTimeoutMs);
      if (timer.unref) timer.unref();
      pendingOpens.set(room.code, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      send(n.ws, { op: 'open_room', code: room.code, room_token: room.roomToken });
    });
  }

  /** 通知节点关房（节点不在线时静默跳过） */
  function closeRoom(nodeId, code) {
    const n = nodes.get(nodeId);
    if (n && n.connected) send(n.ws, { op: 'close_room', code });
  }

  function onlineNodes() {
    return [...nodes.values()].filter((n) => n.connected);
  }

  function close() {
    clearInterval(sweeper);
  }

  // Token 管理方法（供 admin API 使用）
  function getTokenInfo(token) {
    return allTokens.get(token) || null;
  }
  function getTokenInfoById(id) {
    for (const info of allTokens.values()) {
      if (info.id === id) return info;
    }
    return null;
  }
  function allTokenInfos() {
    return [...allTokens.values()].map((info) => ({
      ...info,
      // 脱敏：不返回完整 token
      tokenPreview: info.token.length > 8
        ? info.token.slice(0, 4) + '...' + info.token.slice(-4)
        : '****',
      online: nodes.has(info.id) && nodes.get(info.id).connected
    }));
  }
  function addToken(info) {
    if (!info || !info.token) return false;
    if (allTokens.has(info.token)) return false;
    allTokens.set(info.token, { ...info, createdAt: info.createdAt || Date.now() });
    return true;
  }
  function revokeToken(token) {
    const info = allTokens.get(token);
    if (!info) return false;
    allTokens.delete(token);
    // 如果该 token 对应的节点当前在线，断开连接
    const node = nodes.get(info.id);
    if (node) {
      try { node.ws.close(); } catch { /* ignore */ }
      removeNode(info.id, 'kicked');
    }
    return true;
  }

  return {
    openRoom, closeRoom, onlineNodes, removeNode, flushStats, nodes, close,
    // Token 管理
    getTokenInfo, getTokenInfoById, allTokenInfos, addToken, revokeToken
  };
}

module.exports = { createNodeGateway };
