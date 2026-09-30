'use strict';

/**
 * 好友 / 邀请 API（Phase C）。
 *
 * 好友数据代理自 MindFourm（via forumClient）；邀请写入 Redis 并通过 Forum 通知。
 */

const Router = require('@koa/router');
const { bearerToken } = require('../middleware/currentUser');
const { inviteKey } = require('../db/redisKeys');

const router = new Router();

let forumClient = null;
let tokenService = null;
let presenceService = null;
let registry = null;

function setFriendsServices(services) {
  forumClient = services.forumClient || null;
  tokenService = services.tokenService || null;
  presenceService = services.presenceService || null;
  registry = services.registry || null;
}

function requireUser(ctx) {
  const token = bearerToken(ctx);
  const payload = tokenService && tokenService.verify(token);
  if (!payload || !payload.user) {
    ctx.status = 401;
    ctx.body = { ok: false, code: 'auth_required', message: '请先登录' };
    return null;
  }
  return payload.user;
}

// GET /api/friends — 好友列表 + 各自 presence（LanLink 侧）
router.get('/friends', async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  if (!forumClient) {
    ctx.status = 503;
    ctx.body = { ok: false, code: 'forum_unavailable', message: '论坛服务未配置' };
    return;
  }
  try {
    const friendsResult = await forumClient.getFriends(user.id);
    const friends = friendsResult.friends || [];
    if (friends.length === 0) {
      ctx.body = { ok: true, friends: [] };
      return;
    }
    const userIds = friends.map(f => f.id);
    let presences = {};
    try {
      const pr = await forumClient.getFriendPresences(userIds);
      presences = pr.presences || {};
    } catch (_e) {
      // presence 不可用不影响好友列表
    }
    ctx.body = {
      ok: true,
      friends: friends.map(f => ({
        ...f,
        presence: presences[String(f.id)] || { status: 'offline' }
      }))
    };
  } catch (err) {
    ctx.status = 502;
    ctx.body = { ok: false, code: 'forum_error', message: err.message };
  }
});

// GET /api/friends/requests — 待处理请求
router.get('/friends/requests', async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  if (!forumClient) {
    ctx.status = 503;
    ctx.body = { ok: false, code: 'forum_unavailable', message: '论坛服务未配置' };
    return;
  }
  try {
    const result = await forumClient.getFriendRequests(user.id);
    ctx.body = { ok: true, requests: result.requests || [] };
  } catch (err) {
    ctx.status = 502;
    ctx.body = { ok: false, code: 'forum_error', message: err.message };
  }
});

// POST /api/invites/send — 房主邀请好友
router.post('/invites/send', async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const { room_code, friend_user_id } = ctx.request.body || {};
  if (!room_code || !friend_user_id) {
    ctx.status = 400;
    ctx.body = { ok: false, message: '缺少 room_code 或 friend_user_id' };
    return;
  }
  if (!forumClient) {
    ctx.status = 503;
    ctx.body = { ok: false, code: 'forum_unavailable', message: '论坛服务未配置' };
    return;
  }
  // 校验房间存在且用户是房主
  const room = registry && registry.get(String(room_code).toUpperCase());
  if (!room || !room.roomPort) {
    ctx.status = 404;
    ctx.body = { ok: false, message: '房间不存在或已关闭' };
    return;
  }
  if (!room.ownerWs || String(room.owner && room.owner.id) !== String(user.id)) {
    ctx.status = 403;
    ctx.body = { ok: false, message: '只有房主可以发送邀请' };
    return;
  }
  // 校验是好友
  let isFriend = false;
  try { isFriend = await forumClient.checkFriendship(user.id, friend_user_id); } catch (_e) { /* ignore */ }
  if (!isFriend) {
    ctx.status = 403;
    ctx.body = { ok: false, message: '只能邀请好友' };
    return;
  }
  // 写 Redis invite
  try {
    const { redis } = require('../db/redis');
    await redis.set(inviteKey(friend_user_id, room.code), JSON.stringify({
      from_user_id: user.id,
      from_username: user.username,
      from_display_name: user.display_name,
      from_avatar_url: user.avatar_url,
      room_code: room.code,
      room_name: room.name,
      room_display_name: room.displayName,
      node_name: room.nodeName,
      created_at: Date.now()
    }), 'EX', 600);
  } catch (_e) {
    // Redis 不可用不阻塞
  }
  // 调 Forum 发通知
  try {
    await forumClient.sendNotification(friend_user_id, 'friend_invite', {
      from_user: { id: user.id, username: user.username, avatar_url: user.avatar_url },
      room: {
        code: room.code,
        name: room.name,
        display_name: room.displayName,
        node_name: room.nodeName
      },
      expires_in: 600
    });
  } catch (_e) {
    // 通知失败不阻塞
  }
  ctx.body = { ok: true };
});

// POST /api/invites/respond — 客人响应邀请
router.post('/invites/respond', async (ctx) => {
  const user = requireUser(ctx);
  if (!user) return;
  const { room_code, action } = ctx.request.body || {};
  if (!room_code || !action) {
    ctx.status = 400;
    ctx.body = { ok: false, message: '缺少 room_code 或 action' };
    return;
  }
  let raw;
  try {
    const { redis } = require('../db/redis');
    raw = await redis.get(inviteKey(user.id, room_code));
  } catch (_e) {
    raw = null;
  }
  if (!raw) {
    ctx.status = 404;
    ctx.body = { ok: false, message: '邀请不存在或已过期' };
    return;
  }
  if (action === 'accept') {
    const room = registry && registry.get(String(room_code).toUpperCase());
    if (!room || !room.roomPort) {
      ctx.status = 404;
      ctx.body = { ok: false, message: '房间已关闭' };
      return;
    }
    try {
      const { redis } = require('../db/redis');
      await redis.del(inviteKey(user.id, room_code));
    } catch (_e) { /* ignore */ }
    ctx.body = {
      ok: true,
      room: {
        code: room.code,
        name: room.name,
        display_name: room.displayName,
        node: {
          id: room.nodeId,
          name: room.nodeName,
          addr: room.nodeAddr,
          room_port: room.roomPort,
          tunnel_port: room.tunnelPort
        }
      }
    };
  } else if (action === 'decline') {
    try {
      const { redis } = require('../db/redis');
      await redis.del(inviteKey(user.id, room_code));
    } catch (_e) { /* ignore */ }
    ctx.body = { ok: true };
  } else {
    ctx.status = 400;
    ctx.body = { ok: false, message: 'action 必须是 accept 或 decline' };
  }
});

module.exports = { router, setFriendsServices };
