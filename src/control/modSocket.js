'use strict';

const crypto = require('crypto');
const { canUseNode, filterUsableNodes } = require('./nodeAccess');
const { formatDisplayName, sanitizeLabelPart } = require('./displayName');

// 房主连接后未创建房间的空闲超时（30 分钟）
const HOST_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// 房主自定义房名仍作为纯文本保存；LanLink 彩色标识走 display_name，避免污染真实房名。
/**
 * Mod ↔ 控制面网关（/ws/mod，PROTOCOL.md §1）。
 *
 * hello / create_room / close_room / ping；错误码 upgrade_required / no_node /
 * invalid_op / node_error / resume_failed（协议错误码可扩展，"等"）。
 *
 * 房主 WS 断开 → registry 启动 60s 宽限定时器；期间携 resume=room_token 的
 * hello 可恢复（响应 hello_ok 后补发 room_ok 让 Mod 重新获得房间信息）。
 */
function createModGateway({ wss, registry, nodeGateway, picker, tokenService = null, accessConfig = null, presenceService = null, settings = {}, log = console }) {
  const {
    protocolVersion = 1,
    motd = '',
    latest = '0.1.0',
    serverVersion = latest,
    downloadUrl = ''
  } = settings;

  function publicUser(user) {
    if (!user) return { type: 'anonymous', display_name: '匿名房主' };
    return {
      type: user.type === 'dev' ? 'dev' : 'forum',
      id: user.id,
      username: user.username || '',
      display_name: user.display_name || user.username || '',
      role: user.role || 'user',
      roles: user.roles || [user.role || 'user'],
      phone_verified: !!user.phone_verified
    };
  }

  function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function sendError(ws, code, msg, extra = {}) {
    send(ws, { op: 'error', code, msg, ...extra });
  }

  function roomOk(room) {
    return {
      op: 'room_ok',
      code: room.code,
      room_token: room.roomToken,
      display_name: room.displayName || '',
      mod_version: room.modVersion || '',
      server_version: room.serverVersion || serverVersion,
      owner: room.owner || { type: 'anonymous', display_name: '匿名房主' },
      node: {
        id: room.nodeId,
        name: room.nodeName || room.nodeId,
        addr: room.nodeAddr,
        room_port: room.roomPort,
        tunnel_port: room.tunnelPort
      }
    };
  }

  // 房间销毁统一出口：通知节点关房 + 给房主发 room_closed
  registry.onDestroy = (room, reason) => {
    nodeGateway.closeRoom(room.nodeId, room.code);
    send(room.ownerWs, { op: 'room_closed', reason });
  };

  wss.on('connection', (ws) => {
    const state = { hello: false, room: null, connId: crypto.randomUUID(), modVersion: '', user: null, idleTimer: null };
    ws.on('error', () => {});

    // 空闲超时：连接后 30 分钟内必须创建房间，否则断开
    state.idleTimer = setTimeout(() => {
      if (!state.room) {
        log.info(`[mod] 空闲超时，断开连接（未创建房间）`);
        try { ws.close(); } catch { /* ignore */ }
      }
    }, HOST_IDLE_TIMEOUT_MS);
    if (state.idleTimer.unref) state.idleTimer.unref();

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return sendError(ws, 'invalid_op', '消息不是合法 JSON');
      }
      switch (msg.op) {
        case 'hello': return handleHello(ws, state, msg);
        case 'create_room': return handleCreateRoom(ws, state, msg);
        case 'close_room': return handleCloseRoom(ws, state);
        case 'ping': return send(ws, { op: 'pong' });
        case 'pong': return;
        default: return sendError(ws, 'invalid_op', `未知操作: ${msg.op}`);
      }
    });

    ws.on('close', () => {
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }
      if (presenceService && state.user && state.user.id) {
        presenceService.deletePresence(state.user.id).catch(() => {});
      }
      const room = state.room && registry.get(state.room.code);
      // 只有当前 WS 仍是房主连接时才进入宽限（resume 后旧连接的 close 不得误伤）
      if (room && room.ownerWs === ws) registry.markOwnerDisconnected(room);
    });
  });

  function handleHello(ws, state, msg) {
    if (typeof msg.ver !== 'number' || msg.ver < protocolVersion) {
      sendError(ws, 'upgrade_required', 'LanLink Mod 版本过旧，请更新到最新版本', {
        url: downloadUrl,
        latest,
        required_version: protocolVersion
      });
      ws.close();
      return;
    }

    if (msg.token) {
      const payload = tokenService && tokenService.verify(msg.token);
      if (!payload) {
        sendError(ws, 'auth_invalid', '登录已失效，请重新登录');
        return;
      }
      state.user = payload.user;
    } else {
      state.user = null;
    }
    state.hello = true;
    state.modVersion = sanitizeLabelPart(msg.mod_version, '', 24);
    send(ws, { op: 'hello_ok', motd, latest, server_version: serverVersion, user: publicUser(state.user) });

    if (msg.resume) {
      const room = registry.resume(msg.resume, ws, state.connId);
      if (room) {
        state.room = room;
        send(ws, roomOk(room));
        // resume 也算重新进入联机大厅
        if (presenceService && state.user && state.user.id) {
          presenceService.setPresence(state.user.id, { status: 'online' }).catch(() => {});
        }
      } else {
        sendError(ws, 'resume_failed', '房间已销毁或不存在');
      }
    } else {
      // 正常 hello（非 resume）：标记在线
      if (presenceService && state.user && state.user.id) {
        presenceService.setPresence(state.user.id, { status: 'online' }).catch(() => {});
      }
    }
  }

  function sanitizeDirectCandidate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const mode = raw.mode;
    if (mode !== 'upnp' && mode !== 'stun' && mode !== 'manual') return null;
    const addr = sanitizeLabelPart(raw.addr, '', 128);
    const tcpPort = Number(raw.tcp_port);
    const udpPort = Number(raw.udp_port);
    if (!addr || !Number.isInteger(tcpPort) || !Number.isInteger(udpPort)) return null;
    if (tcpPort < 1 || tcpPort > 65535 || udpPort < 1 || udpPort > 65535) return null;
    // UPnP 模式要求 TCP/UDP 外部端口同号（UPnP IGD 限制）
    if (mode === 'upnp' && tcpPort !== udpPort) return null;
    const ttl = Number(raw.ttl) || 0;
    return { mode, addr, tcp_port: tcpPort, udp_port: udpPort, ttl };
  }

  function sanitizeDirectCandidates(direct, directCandidatesRaw) {
    const legacy = sanitizeDirectCandidate(direct);
    const arr = Array.isArray(directCandidatesRaw)
      ? directCandidatesRaw.map(sanitizeDirectCandidate).filter(Boolean)
      : [];
    // 合并 + 去重（按 addr:tcp_port:udp_port）
    const all = legacy ? [legacy, ...arr] : arr;
    const seen = new Set();
    const unique = [];
    for (const c of all) {
      const key = `${c.addr}:${c.tcp_port}:${c.udp_port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }
    return { legacy, candidates: unique };
  }

  function handleCreateRoom(ws, state, msg) {
    if (!state.hello) return sendError(ws, 'invalid_op', '请先发送 hello');
    if (state.room && registry.get(state.room.code)) {
      return sendError(ws, 'invalid_op', '当前连接已持有房间');
    }

    // 手机号验证：仅对已登录用户检查
    if (state.user && !state.user.phone_verified) {
      return sendError(ws, 'phone_verification_required',
        '需要先验证手机号才能创建房间',
        { verify_url: settings.verificationPageUrl }
      );
    }

    const onlineNodes = nodeGateway.onlineNodes();
    let node = null;

    if (picker.hasNodeSelection({
      nodeId: msg.node_id,
      relayAddr: msg.relay_addr
    })) {
      node = picker.pickRequestedNode(onlineNodes, {
        nodeId: msg.node_id,
        relayAddr: msg.relay_addr,
        relayTunnelPort: msg.relay_tunnel_port
      });
      if (!node) {
        return sendError(ws, 'node_not_found', '指定的中继节点不存在或未在线');
      }
      const access = canUseNode(node, state.user, accessConfig || undefined);
      if (!access.usable) {
        return sendError(ws, 'node_forbidden', access.reason === 'login_required' ? '该中继节点需要登录后才能使用' : '当前账号无权使用该中继节点', { reason: access.reason });
      }
    } else {
      const usableNodes = filterUsableNodes(onlineNodes, state.user, accessConfig || undefined);
      node = picker.pickNode(usableNodes);
      if (!node) return sendError(ws, 'no_node', '当前没有可用的中继节点');
    }

    const nodeName = sanitizeLabelPart(node.name, node.id, 32);
    const modVersion = sanitizeLabelPart(state.modVersion, '', 24);
    const displayName = formatDisplayName({ modVersion, serverVersion, nodeName });
    const { legacy: direct, candidates: directCandidates } = sanitizeDirectCandidates(msg.direct, msg.direct_candidates);

    const room = registry.createRoom({
      name: typeof msg.name === 'string' ? msg.name.slice(0, 100) : '',
      displayName,
      modVersion,
      serverVersion,
      nodeName,
      direct,
      directCandidates,
      // Forum visibility is opt-in. Only an explicit JSON boolean true grants
      // consent; missing values and truthy strings must remain private.
      isPublic: msg.public === true,
      vanillaJoin: msg.vanilla_join !== false,
      gamePort: Number.isInteger(msg.game_port) ? msg.game_port : 6567,
      nodeId: node.id,
      nodeAddr: node.addr,
      tunnelPort: node.tunnelPort,
      owner: publicUser(state.user),
      ownerWs: ws,
      ownerConnId: state.connId
    });
    state.room = room;

    // 清除空闲超时定时器
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

    nodeGateway.openRoom(node.id, room)
      .then(() => {
        if (presenceService && state.user && state.user.id) {
          presenceService.setPresence(state.user.id, {
            status: 'hosting',
            room_code: room.code,
            room_name: room.name,
            display_name: room.displayName,
            node_name: room.nodeName
          }).catch(() => {});
        }
        send(ws, roomOk(room));
      })
      .catch((err) => {
        log.error('[mod] open_room failed:', err && err.message);
        state.room = null;
        room.ownerWs = null; // 开房失败走 error 回复，不再给房主发 room_closed
        registry.destroyRoom(room.code, 'node_down');
        sendError(ws, 'node_error', '节点开房失败，请稍后重试');
      });
  }

  function handleCloseRoom(ws, state) {
    const room = state.room && registry.get(state.room.code);
    if (!room) {
      state.room = null;
      return sendError(ws, 'invalid_op', '当前没有房间');
    }
    state.room = null;
    registry.destroyRoom(room.code, 'owner');
    // 关房后仍在线：hosting → online
    if (presenceService && state.user && state.user.id) {
      presenceService.setPresence(state.user.id, { status: 'online' }).catch(() => {});
    }
  }
}

module.exports = { createModGateway };
