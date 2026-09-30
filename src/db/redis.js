'use strict';

const Redis = require('ioredis');
const config = require('../config');
const { roomKey, nodeKey } = require('./redisKeys');

// 创建 Redis 连接
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  db: config.redis.db,
  connectTimeout: 10000,
  retryStrategy: (times) => {
    if (times > 10) return null; // 放弃重试
    return Math.min(times * 500, 5000);
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  }
});

redis.on('connect', () => console.log('Redis connected'));
redis.on('error', (err) => console.error('Redis error:', err));

// ---- key 约定：全部 lanlink: 前缀、冒号分层 ----
// 节点 key TTL：30s，心跳刷新；超时即视为掉线
const NODE_TTL_SECONDS = 30;

/**
 * 保存/更新房间 Hash lanlink:room:{code}
 * @param {object} room roomRegistry 里的房间对象
 */
async function saveRoom(room) {
  await redis.hset(roomKey(room.code), {
    room_token: room.roomToken,
    name: room.name || '',
    display_name: room.displayName || '',
    mod_version: room.modVersion || '',
    server_version: room.serverVersion || '',
    node_name: room.nodeName || '',
    direct: room.direct ? JSON.stringify(room.direct) : '',
    owner: room.owner ? JSON.stringify(room.owner) : '',
    hidden: room.hidden ? '1' : '0',
    hidden_reason: room.hiddenReason || '',
    node_id: room.nodeId || '',
    room_port: room.roomPort == null ? '' : String(room.roomPort),
    game_port: room.gamePort == null ? '' : String(room.gamePort),
    is_public: room.isPublic ? '1' : '0',
    owner_connected: room.ownerConnected ? '1' : '0',
    owner_conn: room.ownerConnId || '',
    created_at: String(room.createdAt || Date.now())
  });
}

/**
 * 读取房间 Hash
 * @param {string} code
 * @returns {Promise<object|null>}
 */
async function getRoom(code) {
  const hash = await redis.hgetall(roomKey(code));
  return Object.keys(hash).length > 0 ? hash : null;
}

/** 删除房间 Hash */
async function deleteRoom(code) {
  await redis.del(roomKey(code));
}

/**
 * 保存节点信息 lanlink:node:{id}（TTL 30s，心跳刷新）
 * @param {string} id
 * @param {object} info
 */
async function saveNode(id, info) {
  await redis.hset(nodeKey(id), {
    addr: info.addr || '',
    name: info.name || id,
    tunnel_port: String(info.tunnelPort || 0),
    mbps: String(info.mbps || 0),
    rooms: String((info.stats && info.stats.rooms) || 0),
    sessions: String((info.stats && info.stats.sessions) || 0),
    mbps_used: String((info.stats && info.stats.mbpsUsed) || 0),
    last_seen: String(Date.now())
  });
  await redis.expire(nodeKey(id), NODE_TTL_SECONDS);
}

/** 心跳刷新节点 TTL */
async function refreshNode(id) {
  await redis.expire(nodeKey(id), NODE_TTL_SECONDS);
}

/** 摘除节点 */
async function deleteNode(id) {
  await redis.del(nodeKey(id));
}

// 关闭连接
async function close() {
  await redis.quit();
}

module.exports = {
  redis,
  saveRoom,
  getRoom,
  deleteRoom,
  saveNode,
  refreshNode,
  deleteNode,
  close
};
