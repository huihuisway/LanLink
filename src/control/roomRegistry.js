'use strict';

const crypto = require('crypto');

// 房间码字母表：剔除 0 O 1 I，共 32 个字符
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/**
 * 房间注册表（内存为准，Redis/MySQL 通过注入的 persistence 异步跟写）。
 *
 * persistence 接口（全部可选，测试可不注入）：
 *   saveRoom(room)      — 写 Redis Hash lanlink:room:{code}
 *   deleteRoom(code)    — 删 Redis Hash
 *   writeHistory(entry) — 写 MySQL rooms_history
 *
 * 房主 WS 断开后启动 graceMs（默认 60s）宽限定时器，超时销毁房间；
 * 期间携 resume=room_token 的 hello 可恢复。
 *
 * @param {{persistence?:object, graceMs?:number, log?:Console}} opts
 */
function createRoomRegistry({ persistence = null, graceMs = 60000, log = console } = {}) {
  const rooms = new Map();    // code -> room
  const byToken = new Map();  // roomToken -> room

  function fireAndForget(promise, what) {
    Promise.resolve(promise).catch((err) => {
      log.error(`[registry] ${what} failed:`, err && err.message);
    });
  }

  function persist(room) {
    if (persistence && typeof persistence.saveRoom === 'function') {
      fireAndForget(persistence.saveRoom(room), 'saveRoom');
    }
  }

  /** 生成房间码 MDT-XXXXXX（crypto.randomInt，碰撞重试） */
  function generateCode() {
    for (;;) {
      let s = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      }
      const code = `MDT-${s}`;
      if (!rooms.has(code)) return code;
    }
  }

  /**
   * 创建房间：房间码 + roomToken（16 随机字节 hex）
   */
  function createRoom({ name, displayName, modVersion, serverVersion, nodeName, direct = null, directCandidates = [], isPublic, vanillaJoin, gamePort, nodeId, nodeAddr, tunnelPort, ownerWs, ownerConnId, owner = null }) {
    const code = generateCode();
    const roomToken = crypto.randomBytes(16).toString('hex');
    const room = {
      code,
      roomToken,
      name: name || '',
      displayName: displayName || '',
      modVersion: modVersion || '',
      serverVersion: serverVersion || '',
      nodeName: nodeName || nodeId || '',
      direct,
      directCandidates: Array.isArray(directCandidates) ? directCandidates : [],
      owner: owner || { type: 'anonymous', display_name: '匿名房主' },
      hidden: false,
      hiddenReason: '',
      isPublic: !!isPublic,
      vanillaJoin: vanillaJoin !== false,
      gamePort: gamePort || null,
      nodeId,
      nodeAddr,
      tunnelPort,
      roomPort: null,
      ownerWs: ownerWs || null,
      ownerConnId: ownerConnId || '',
      ownerConnected: true,
      graceTimer: null,
      createdAt: Date.now()
    };
    rooms.set(code, room);
    byToken.set(roomToken, room);
    persist(room);
    return room;
  }

  /** 节点开房成功后回填公网端口 */
  function setRoomPort(code, port) {
    const room = rooms.get(code);
    if (!room) return;
    room.roomPort = port;
    persist(room);
  }

  /** 房主 WS 断开：启动宽限定时器，超时销毁 */
  function markOwnerDisconnected(room) {
    if (!rooms.has(room.code)) return;
    room.ownerWs = null;
    room.ownerConnected = false;
    persist(room);
    if (room.graceTimer) clearTimeout(room.graceTimer);
    room.graceTimer = setTimeout(() => destroyRoom(room.code, 'owner'), graceMs);
    if (room.graceTimer.unref) room.graceTimer.unref();
  }

  /** 宽限期内携 resume=room_token 恢复房间 */
  function resume(roomToken, ws, connId) {
    const room = byToken.get(roomToken);
    if (!room) return null;
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
    room.ownerWs = ws;
    room.ownerConnId = connId || '';
    room.ownerConnected = true;
    persist(room);
    return room;
  }

  /**
   * 销毁房间：清内存、清 Redis、写 rooms_history，并触发 onDestroy 钩子
   * （由装配方设置：通知节点 close_room、给房主发 room_closed）。
   * @param {string} code
   * @param {'owner'|'node_down'|'kicked'} reason
   */
  function destroyRoom(code, reason) {
    const room = rooms.get(code);
    if (!room) return null;
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
    rooms.delete(code);
    byToken.delete(room.roomToken);
    if (persistence && typeof persistence.deleteRoom === 'function') {
      fireAndForget(persistence.deleteRoom(code), 'deleteRoom');
    }
    if (persistence && typeof persistence.writeHistory === 'function') {
      fireAndForget(persistence.writeHistory({
        code: room.code,
        name: room.name,
        nodeId: room.nodeId,
        roomPort: room.roomPort,
        reason,
        createdAt: room.createdAt
      }), 'writeHistory');
    }
    if (typeof api.onDestroy === 'function') api.onDestroy(room, reason);
    return room;
  }

  function get(code) {
    return rooms.get(code);
  }

  function getByToken(roomToken) {
    return byToken.get(roomToken);
  }

  function hideRoom(code, reason = '') {
    const room = rooms.get(code);
    if (!room) return null;
    room.hidden = true;
    room.hiddenReason = reason || '';
    persist(room);
    return room;
  }

  function roomsOnNode(nodeId) {
    return [...rooms.values()].filter((r) => r.nodeId === nodeId);
  }

  function all() {
    return [...rooms.values()];
  }

  function count() {
    return rooms.size;
  }

  const api = {
    createRoom,
    setRoomPort,
    markOwnerDisconnected,
    resume,
    destroyRoom,
    get,
    getByToken,
    hideRoom,
    roomsOnNode,
    all,
    count,
    // 装配方设置：(room, reason) => void
    onDestroy: null
  };

  return api;
}

module.exports = { createRoomRegistry, CODE_ALPHABET };
