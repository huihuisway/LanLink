'use strict';

const { presenceKey } = require('../db/redisKeys');

/**
 * LanLink 自身 presence 写入/读取（Redis）。
 *
 * 写入时机：
 *   - modSocket handleHello（type='online'）
 *   - modSocket handleCreateRoom 成功（type='hosting'，附房间信息）
 *   - modSocket WS close（删除）
 *
 * 与 MindFourm 的外部 presence 独立：MindFourm 记录论坛侧的在线状态，
 * LanLink 记录"在联机大厅里"的在线状态，供好友列表 / 邀请等场景使用。
 */
function createPresenceService({ redis, config, prefix = 'lanlink:presence:', ttlSeconds } = {}) {
  const PRESENCE_PREFIX = prefix;
  const PRESENCE_TTL = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? ttlSeconds
    : (config && config.presenceTtlSeconds) || 120;

  async function setPresence(userId, data) {
    if (!userId) return;
    const payload = { ...(data || {}), updated_at: Date.now() };
    await redis.set(presenceKey(userId, PRESENCE_PREFIX), JSON.stringify(payload), 'EX', PRESENCE_TTL);
  }

  async function deletePresence(userId) {
    if (!userId) return;
    await redis.del(presenceKey(userId, PRESENCE_PREFIX));
  }

  async function getPresence(userId) {
    if (!userId) return null;
    const raw = await redis.get(presenceKey(userId, PRESENCE_PREFIX));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return { setPresence, deletePresence, getPresence, PRESENCE_PREFIX, PRESENCE_TTL };
}

module.exports = { createPresenceService };
