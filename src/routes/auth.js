'use strict';

const Router = require('@koa/router');
const crypto = require('crypto');
const { bearerToken } = require('../middleware/currentUser');
const redisKeys = require('../db/redisKeys');

const router = new Router();

let forumClient = null;
let tokenService = null;
let config = null;
let rateLimitRedis = null;

function setAuthServices(services = {}) {
  forumClient = services.forumClient || null;
  tokenService = services.tokenService || null;
  config = services.config || null;
  rateLimitRedis = services.redis || null;
}

async function _mindAuthJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  return { status: res.status, ok: res.ok, body: body || {} };
}

async function deleteDeviceSession(sessionId) {
  const { redis } = require('../db/redis');
  await redis.del(
    redisKeys.deviceSessionKey(sessionId),
    redisKeys.legacyDeviceSessionKey(sessionId)
  );
}

// ---- 用户名密码直接登录（新流程）----

router.post('/login', async (ctx) => {
  if (!forumClient || !tokenService) {
    ctx.status = 503;
    ctx.body = { ok: false, code: 'auth_unavailable', message: '登录服务未配置' };
    return;
  }

  const { username, password } = ctx.request.body || {};
  if (!username || !password) {
    ctx.status = 400;
    ctx.body = { ok: false, code: 'missing_credentials', message: '请提供用户名和密码' };
    return;
  }

  // IP 速率限制：每分钟最多 30 次
  const clientIp = ctx.state.realIp || ctx.ip || 'unknown';
  const normalizedUsername = String(username).trim().toLowerCase();
  try {
    const redis = rateLimitRedis || require('../db/redis').redis;
    const ipLimitKey = redisKeys.loginIpLimitKey(clientIp);
    const ipAttempts = await redis.incr(ipLimitKey);
    if (ipAttempts === 1) {
      await redis.expire(ipLimitKey, 60);
    }
    if (ipAttempts > 30) {
      ctx.status = 429;
      ctx.body = { ok: false, code: 'rate_limited', message: '登录尝试过于频繁，请稍后再试' };
      return;
    }

    // 用户名速率限制：每分钟最多 30 次
    const userLimitKey = redisKeys.loginUserLimitKey(normalizedUsername);
    const userAttempts = await redis.incr(userLimitKey);
    if (userAttempts === 1) {
      await redis.expire(userLimitKey, 60);
    }
    if (userAttempts > 30) {
      ctx.status = 429;
      ctx.body = { ok: false, code: 'rate_limited', message: '该账号登录尝试过于频繁' };
      return;
    }
  } catch (err) {
    // Redis 错误，继续但不记录详细信息
    console.error('Rate limit check failed:', err.message);
  }

  // 调用论坛验证
  let forumUser;
  try {
    forumUser = await forumClient.validateUsernamePassword(username, password);
  } catch (err) {
    ctx.status = 502;
    ctx.body = { ok: false, code: 'forum_error', message: err.message || '论坛验证失败' };
    return;
  }

  if (!forumUser) {
    ctx.status = 401;
    ctx.body = { ok: false, code: 'invalid_credentials', message: '用户名或密码错误' };
    return;
  }

  // dev 模式
  if (forumClient.devMode) {
    forumUser.type = 'dev';
  }

  const user = tokenService.sanitizeUser(forumUser);
  const token = tokenService.issue(user);
  ctx.body = {
    ok: true,
    token,
    expires_in: tokenService.ttlSeconds,
    user: publicUser(user)
  };
});

// ---- MindAuth 设备授权流（Phase C）----
// 已废弃，过渡期保留

router.post('/device/start', async (ctx) => {
  // 标记为废弃
  ctx.set('Deprecation', 'true');
  ctx.set('Sunset', 'Sat, 01 Jan 2027 00:00:00 GMT');
  ctx.set('Link', '</api/auth/login>; rel="successor-version"');

  const maConfig = config && config.mindauth;
  if (!maConfig || !maConfig.baseUrl) {
    ctx.status = 503;
    ctx.body = { ok: false, code: 'mindauth_unavailable', message: 'MindAuth 未配置' };
    return;
  }
  const clientId = (ctx.request.body && ctx.request.body.client_id) || maConfig.clientId || 'lanlink-mod';
  const clientSecret = maConfig.clientSecret || '';
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const { status, ok, body } = await _mindAuthJson(`${maConfig.baseUrl}/api/oauth/device/code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${basicAuth}`
    },
    body: JSON.stringify({ client_id: clientId, scope: 'openid profile' })
  });
  if (!ok) {
    ctx.status = status >= 400 && status < 600 ? status : 502;
    ctx.body = { ok: false, code: 'mindauth_error', message: (body && (body.error_description || body.error || body.message)) || `MindAuth 返回 HTTP ${status}` };
    return;
  }
  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = body || {};
  if (!device_code || !user_code) {
    ctx.status = 502;
    ctx.body = { ok: false, code: 'mindauth_error', message: 'MindAuth 返回数据不完整' };
    return;
  }
  const sessionId = crypto.randomUUID();
  try {
    const { redis } = require('../db/redis');
    await redis.set(
      redisKeys.deviceSessionKey(sessionId),
      JSON.stringify({ device_code, client_id: clientId }),
      'EX',
      Number(expires_in) || 600
    );
  } catch (err) {
    ctx.status = 500;
    ctx.body = { ok: false, code: 'redis_error', message: '无法保存设备会话' };
    return;
  }
  ctx.body = {
    ok: true,
    session_id: sessionId,
    user_code,
    verification_uri: verification_uri || '',
    verification_uri_complete: verification_uri_complete || '',
    expires_in: Number(expires_in) || 600,
    interval: Number(interval) || 5
  };
});

router.post('/device/poll', async (ctx) => {
  // 标记为废弃
  ctx.set('Deprecation', 'true');
  ctx.set('Sunset', 'Sat, 01 Jan 2027 00:00:00 GMT');
  ctx.set('Link', '</api/auth/login>; rel="successor-version"');

  const sessionId = ctx.request.body && ctx.request.body.session_id;
  if (!sessionId) {
    ctx.status = 400;
    ctx.body = { ok: false, message: '缺少 session_id' };
    return;
  }
  const maConfig = config && config.mindauth;
  if (!maConfig || !maConfig.baseUrl) {
    ctx.status = 503;
    ctx.body = { ok: false, code: 'mindauth_unavailable', message: 'MindAuth 未配置' };
    return;
  }
  let deviceData;
  try {
    const { redis } = require('../db/redis');
    const raw = await redis.get(redisKeys.deviceSessionKey(sessionId))
      || await redis.get(redisKeys.legacyDeviceSessionKey(sessionId));
    if (!raw) {
      ctx.status = 400;
      ctx.body = { ok: false, message: 'session 不存在或已过期' };
      return;
    }
    deviceData = JSON.parse(raw);
  } catch (_e) {
    ctx.status = 400;
    ctx.body = { ok: false, message: 'session 不存在或已过期' };
    return;
  }
  const { device_code, client_id } = deviceData;
  const clientSecret = maConfig.clientSecret || '';
  const basicAuth = Buffer.from(`${client_id}:${clientSecret}`).toString('base64');
  const { status, ok, body } = await _mindAuthJson(`${maConfig.baseUrl}/api/oauth/device/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${basicAuth}`
    },
    body: JSON.stringify({
      client_id,
      device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  });
  const errCode = body && body.error;
  if (errCode === 'authorization_pending') {
    ctx.body = { ok: false, status: 'pending' };
    return;
  }
  if (errCode === 'expired_token') {
    try { await deleteDeviceSession(sessionId); } catch (_e) {}
    ctx.body = { ok: false, status: 'expired' };
    return;
  }
  if (errCode === 'access_denied') {
    try { await deleteDeviceSession(sessionId); } catch (_e) {}
    ctx.body = { ok: false, status: 'denied' };
    return;
  }
  if (errCode || !ok) {
    ctx.status = status >= 400 && status < 600 ? status : 502;
    ctx.body = { ok: false, code: 'mindauth_error', message: errCode || `MindAuth 返回 HTTP ${status}` };
    return;
  }
  const accessToken = body && body.access_token;
  if (!accessToken) {
    ctx.status = 502;
    ctx.body = { ok: false, code: 'mindauth_error', message: 'MindAuth 未返回 access_token' };
    return;
  }
  // 取 userinfo
  const userinfoResp = await _mindAuthJson(`${maConfig.baseUrl}/api/oauth/userinfo`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (!userinfoResp.ok) {
    ctx.status = 502;
    ctx.body = { ok: false, code: 'mindauth_error', message: `userinfo 失败 HTTP ${userinfoResp.status}` };
    return;
  }
  const userinfo = userinfoResp.body || {};
  const user = tokenService.sanitizeUser({
    type: 'forum',
    id: userinfo.sub != null ? String(userinfo.sub) : '',
    mindauth_id: userinfo.sub != null ? String(userinfo.sub) : null,
    username: userinfo.preferred_username || userinfo.username || '',
    display_name: userinfo.name || userinfo.preferred_username || '',
    email: userinfo.email || '',
    avatar_url: userinfo.picture || userinfo.avatar_url || '',
    role: 'user',
    roles: ['user'],
    phone_verified: !!userinfo.phone_verified,
    token_version: 0
  });
  if (!user.id) {
    ctx.status = 502;
    ctx.body = { ok: false, code: 'mindauth_error', message: 'userinfo 缺少 id' };
    return;
  }
  try { await deleteDeviceSession(sessionId); } catch (_e) {}
  const token = tokenService.issue(user);
  ctx.body = {
    ok: true,
    token,
    user: publicUser(user),
    expires_in: tokenService.ttlSeconds
  };
});

function publicUser(user) {
  if (!user) return { type: 'anonymous' };
  return {
    type: user.type === 'dev' ? 'dev' : 'forum',
    id: user.id,
    mindauth_id: user.mindauth_id || null,
    username: user.username || '',
    display_name: user.display_name || user.username || '',
    avatar_url: user.avatar_url || '',
    role: user.role || 'user',
    roles: user.roles || [user.role || 'user'],
    phone_verified: !!user.phone_verified
  };
}

router.post('/code/exchange', async (ctx) => {
  if (!forumClient || !tokenService) {
    ctx.status = 503;
    ctx.body = { ok: false, code: 'auth_unavailable', message: '登录服务未配置' };
    return;
  }

  const code = String((ctx.request.body && ctx.request.body.code) || '').trim();
  if (!code) {
    ctx.status = 400;
    ctx.body = { ok: false, code: 'invalid_code', message: '请填写论坛 LanLink 识别码' };
    return;
  }

  let forumUser;
  try {
    forumUser = await forumClient.exchangeQuickCode(code);
  } catch (err) {
    ctx.status = 502;
    ctx.body = { ok: false, code: 'forum_error', message: err && err.message ? err.message : '论坛识别码校验失败' };
    return;
  }

  if (!forumUser) {
    ctx.status = 401;
    ctx.body = { ok: false, code: 'invalid_code', message: '识别码无效或已被重置' };
    return;
  }

  // dev 模式：type 设为 'dev'，让 sanitizeUser + token verify 都识别
  if (forumClient.devMode) {
    forumUser.type = 'dev';
  }
  const user = tokenService.sanitizeUser(forumUser);
  const token = tokenService.issue(user);
  ctx.body = {
    ok: true,
    token,
    expires_in: tokenService.ttlSeconds,
    user: publicUser(user)
  };
});

router.get('/me', async (ctx) => {
  const token = bearerToken(ctx);
  const payload = tokenService && tokenService.verify(token);
  if (!payload) {
    ctx.status = 401;
    ctx.body = { ok: false, code: 'auth_invalid', message: '登录已失效' };
    return;
  }
  ctx.body = { ok: true, user: publicUser(payload.user) };
});

router.post('/refresh', async (ctx) => {
  const token = bearerToken(ctx);
  const payload = tokenService && tokenService.verify(token);
  if (!payload || !payload.user) {
    ctx.status = 401;
    ctx.body = { ok: false, code: 'auth_invalid', message: '登录已失效，请重新登录' };
    return;
  }

  try {
    const redis = rateLimitRedis || require('../db/redis').redis;
    const key = redisKeys.refreshLimitKey(payload.user.id);
    const attempts = await redis.incr(key);
    if (attempts === 1) await redis.expire(key, 60);
    if (attempts > 10) {
      ctx.status = 429;
      ctx.body = { ok: false, code: 'rate_limited', message: '刷新过于频繁，请稍后重试' };
      return;
    }
  } catch (err) {
    console.error('Auth refresh rate limit failed:', err.message);
  }

  let latest;
  try {
    latest = await forumClient.getLanLinkUser(payload.user.id);
  } catch (err) {
    ctx.status = 502;
    ctx.body = { ok: false, code: 'forum_error', message: err.message || '论坛状态刷新失败' };
    return;
  }
  if (!latest) {
    ctx.status = 401;
    ctx.body = { ok: false, code: 'user_not_found', message: '论坛用户不存在，请重新登录' };
    return;
  }

  const refreshedUser = tokenService.sanitizeUser({ ...payload.user, ...latest });
  const refreshedToken = tokenService.issue(refreshedUser);
  ctx.body = {
    ok: true,
    token: refreshedToken,
    expires_in: tokenService.ttlSeconds,
    user: publicUser(refreshedUser)
  };
});

module.exports = { router, setAuthServices, publicUser };
