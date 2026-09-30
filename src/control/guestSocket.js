'use strict';

const crypto = require('crypto');

// 客人连接后未加入房间的空闲超时（5 分钟）
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 客人 ↔ 控制面网关（/ws/guest，PROTOCOL.md §1b）。
 *
 * 客人是加入方 Mod，专用 WS 端点，与 /ws/mod（房主）分离。
 * 主要职责：
 *   - 接收 join_request：客人告知要加入的房间 + 自己的直连候选
 *   - 下发 join_accepted：返回房间信息 + 房主的直连候选（用于打洞）
 *   - 通知房主 peer_joined：携带 peer_id 和客人候选（房主可用来打洞）
 *   - 通知客人 peer_left：房主关闭房间或断开时
 */
function createGuestGateway({ wss, registry, tokenService = null, settings = {}, log = console }) {
  const {
    serverVersion = '0.1.0',
    motd = '',
    latest = '0.1.0'
  } = settings;

  // 每个房间当前在线客人：Map<roomCode, Map<peerId, {ws, user, candidates}>>
  const peersByRoom = new Map();

  function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function sendError(ws, code, msg, extra = {}) {
    send(ws, { op: 'error', code, msg, ...extra });
  }

  function publicUser(user) {
    if (!user) return { type: 'anonymous', display_name: '匿名客人' };
    return {
      type: user.type === 'dev' ? 'dev' : 'forum',
      id: user.id,
      username: user.username || '',
      display_name: user.display_name || user.username || '',
      role: user.role || 'user'
    };
  }

  function sanitizeCandidate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const mode = raw.mode;
    if (mode !== 'upnp' && mode !== 'stun' && mode !== 'manual' && mode !== 'local') return null;
    const addr = String(raw.addr || '').trim();
    const port = Number(raw.udp_port || raw.port);
    if (!addr || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { mode, addr, udp_port: port };
  }

  function sanitizeCandidates(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
      const c = sanitizeCandidate(raw);
      if (!c) continue;
      const key = `${c.addr}:${c.udp_port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  function getOrCreatePeers(roomCode) {
    let peers = peersByRoom.get(roomCode);
    if (!peers) {
      peers = new Map();
      peersByRoom.set(roomCode, peers);
    }
    return peers;
  }

  function removePeer(roomCode, peerId) {
    const peers = peersByRoom.get(roomCode);
    if (!peers) return;
    peers.delete(peerId);
    if (peers.size === 0) peersByRoom.delete(roomCode);
  }

  wss.on('connection', (ws) => {
    const state = { hello: false, room: null, peerId: null, user: null, idleTimer: null };
    ws.on('error', () => {});

    // 空闲超时：连接后 5 分钟内必须完成 join_request，否则断开
    state.idleTimer = setTimeout(() => {
      if (!state.room) {
        log.info(`[guest] 空闲超时，断开连接（未加入房间）`);
        try { ws.close(); } catch { /* ignore */ }
      }
    }, IDLE_TIMEOUT_MS);
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
        case 'join_request': return handleJoinRequest(ws, state, msg);
        case 'leave': return handleLeave(ws, state);
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
      if (state.room && state.peerId) {
        const room = state.room;
        removePeer(room.code, state.peerId);
        // 通知房主
        if (room.ownerWs) {
          send(room.ownerWs, {
            op: 'peer_left',
            peer_id: state.peerId,
            reason: 'disconnected'
          });
        }
      }
    });
  });

  function handleHello(ws, state, msg) {
    const protocolVersion = settings.protocolVersion || 2;
    if (typeof msg.ver !== 'number' || msg.ver < protocolVersion) {
      sendError(ws, 'upgrade_required', 'LanLink Mod 版本过旧，请更新到最新版本', {
        latest,
        url: settings.downloadUrl,
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
    }
    state.hello = true;
    send(ws, { op: 'hello_ok', motd, latest, server_version: serverVersion, user: publicUser(state.user) });
  }

  function handleJoinRequest(ws, state, msg) {
    if (!state.hello) return sendError(ws, 'invalid_op', '请先发送 hello');
    if (state.room) return sendError(ws, 'invalid_op', '已加入房间，请先离开');
    if (!state.user) return sendError(ws, 'login_required', '需要登录后才能加入房间');

    // 检查手机号验证
    if (!state.user.phone_verified) {
      return sendError(ws, 'phone_verification_required',
        '需要先验证手机号才能加入房间',
        { verify_url: settings.verificationPageUrl }
      );
    }

    // 清除空闲超时定时器
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

    const code = String(msg.code || '').trim().toUpperCase();
    const room = registry.get(code);
    if (!room || !room.roomPort) {
      return sendError(ws, 'room_not_found', '房间不存在或已关闭');
    }

    const peerId = crypto.randomUUID();
    const guestCandidates = sanitizeCandidates(msg.candidates);

    // 登记客人
    state.room = room;
    state.peerId = peerId;
    const peers = getOrCreatePeers(room.code);
    peers.set(peerId, { ws, user: state.user, candidates: guestCandidates });

    // 给客人返回 join_accepted
    const hostCandidates = (room.directCandidates || [])
      .filter((c) => c && c.addr && (c.udp_port || c.tcp_port))
      .map((c) => ({ mode: c.mode, addr: c.addr, udp_port: c.udp_port || c.tcp_port }));

    send(ws, {
      op: 'join_accepted',
      peer_id: peerId,
      room: {
        code: room.code,
        name: room.name || '',
        display_name: room.displayName || '',
        node: {
          id: room.nodeId,
          name: room.nodeName || room.nodeId,
          addr: room.nodeAddr,
          room_port: room.roomPort,
          tunnel_port: room.tunnelPort
        }
      },
      host_candidates: hostCandidates,
      host_user: room.owner || { type: 'anonymous', display_name: '匿名房主' }
    });

    // 通知房主
    if (room.ownerWs) {
      send(room.ownerWs, {
        op: 'peer_join',
        conn: 0,
        addr: ws._socket ? `${ws._socket.remoteAddress || '?'}:${ws._socket.remotePort || 0}` : '?:0',
        peer_id: peerId,
        peer_user: publicUser(state.user),
        peer_candidates: guestCandidates
      });
    }
  }

  function handleLeave(ws, state) {
    if (!state.room || !state.peerId) return;
    const room = state.room;
    removePeer(room.code, state.peerId);
    if (room.ownerWs) {
      send(room.ownerWs, {
        op: 'peer_left',
        peer_id: state.peerId,
        reason: 'left'
      });
    }
    state.room = null;
    state.peerId = null;
    send(ws, { op: 'left_ok' });
  }

  // 房间销毁时清理客人连接
  function onRoomDestroyed(room) {
    const peers = peersByRoom.get(room.code);
    if (!peers) return;
    for (const [peerId, peer] of peers) {
      send(peer.ws, { op: 'peer_left', peer_id: peerId, reason: 'owner' });
      try { peer.ws.close(); } catch { /* ignore */ }
    }
    peersByRoom.delete(room.code);
  }

  return { onRoomDestroyed };
}

module.exports = { createGuestGateway };
