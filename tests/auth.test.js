'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const Router = require('@koa/router');
const { createTokenService } = require('../src/auth/tokenService');
const { createClientIpMiddleware, resolveClientIp } = require('../src/middleware/clientIp');
const authRoute = require('../src/routes/auth');

function request(port, method, path, body = null, token = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function startAuthServer({ forumClient, tokenService, redis }) {
  authRoute.setAuthServices({ forumClient, tokenService, redis });
  const app = new Koa();
  app.use(createClientIpMiddleware());
  app.use(bodyParser());
  const router = new Router({ prefix: '/api' });
  router.use('/auth', authRoute.router.routes(), authRoute.router.allowedMethods());
  app.use(router.routes());
  app.use(router.allowedMethods());
  const server = http.createServer(app.callback());
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { port, close: () => server.close() };
}

function createFakeRedis() {
  const entries = new Map();

  return {
    entries,
    async incr(key) {
      const entry = entries.get(key) || { count: 0, ttl: null };
      entry.count += 1;
      entries.set(key, entry);
      return entry.count;
    },
    async expire(key, seconds) {
      const entry = entries.get(key);
      if (!entry) return 0;
      entry.ttl = seconds;
      return 1;
    }
  };
}

test('客户端 IP 解析：统一头优先级链路', () => {
  // ali-real-client-ip 最高优先级
  assert.deepEqual(resolveClientIp({ 'ali-real-client-ip': '203.0.113.10', 'x-real-ip': '198.51.100.1', 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '10.0.0.1' }, '::ffff:127.0.0.1'), {
    ip: '203.0.113.10',
    source: 'header'
  });
  // x-real-ip 次之
  assert.deepEqual(resolveClientIp({ 'x-real-ip': '198.51.100.1', 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '10.0.0.1' }, '::ffff:127.0.0.1'), {
    ip: '198.51.100.1',
    source: 'header'
  });
  // cf-connecting-ip 第三
  assert.deepEqual(resolveClientIp({ 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '10.0.0.1' }, '::ffff:127.0.0.1'), {
    ip: '192.0.2.1',
    source: 'header'
  });
  // x-forwarded-for 首个条目
  assert.deepEqual(resolveClientIp({ 'x-forwarded-for': '203.0.113.10, 198.51.100.8' }, '::ffff:127.0.0.1'), {
    ip: '203.0.113.10',
    source: 'header'
  });
  // 所有头缺失 → socket peer
  assert.deepEqual(resolveClientIp({}, '::ffff:127.0.0.1'), {
    ip: '127.0.0.1',
    source: 'socket'
  });
  // 所有头无效 → socket peer
  assert.deepEqual(resolveClientIp({ 'ali-real-client-ip': 'not-an-ip', 'x-forwarded-for': 'also-bad' }, '::ffff:127.0.0.1'), {
    ip: '127.0.0.1',
    source: 'socket'
  });
  // 空字符串头 → socket peer
  assert.deepEqual(resolveClientIp({ 'x-forwarded-for': '' }, '::ffff:127.0.0.1'), {
    ip: '127.0.0.1',
    source: 'socket'
  });
});

test('tokenService：签发并校验论坛用户 token', () => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const token = tokenService.issue({ id: 7, username: 'alice', role: 'admin', phone_verified: true, token_version: 2 });
  const payload = tokenService.verify(token);
  assert.equal(payload.user.id, '7');
  assert.equal(payload.user.username, 'alice');
  assert.equal(payload.user.role, 'admin');
  assert.equal(payload.user.token_version, 2);
  assert.equal(tokenService.verify(`${token}x`), null);
});

test('POST /api/auth/code/exchange：用论坛识别码换 LanLink token', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const forumClient = {
    async exchangeQuickCode(code) {
      assert.equal(code, 'LL-ABCD-2345');
      return { id: 9, username: 'bob', role: 'user', phone_verified: true, token_version: 1 };
    }
  };
  const server = await startAuthServer({ forumClient, tokenService });
  t.after(() => server.close());

  const exchanged = await request(server.port, 'POST', '/api/auth/code/exchange', { code: 'LL-ABCD-2345' });
  assert.equal(exchanged.statusCode, 200);
  assert.equal(exchanged.body.ok, true);
  assert.equal(exchanged.body.user.username, 'bob');
  assert.ok(exchanged.body.token);

  const me = await request(server.port, 'GET', '/api/auth/me', null, exchanged.body.token);
  assert.equal(me.statusCode, 200);
  assert.equal(me.body.user.id, '9');
});

test('POST /api/auth/code/exchange：无效识别码返回 401', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const forumClient = { async exchangeQuickCode() { return null; } };
  const server = await startAuthServer({ forumClient, tokenService });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/code/exchange', { code: 'LL-BAD2-BAD3' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'invalid_code');
});

test('POST /api/auth/refresh：读取论坛最新手机状态并重签 token', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const redis = createFakeRedis();
  const oldToken = tokenService.issue({ id: 9, username: 'bob', role: 'user', phone_verified: false });
  const forumClient = {
    async getLanLinkUser(userId) {
      assert.equal(userId, '9');
      return { id: 9, username: 'bob', role: 'user', phone_verified: true };
    }
  };
  const server = await startAuthServer({ forumClient, tokenService, redis });
  t.after(() => server.close());

  const refreshed = await request(server.port, 'POST', '/api/auth/refresh', null, oldToken);
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.body.ok, true);
  assert.equal(refreshed.body.user.phone_verified, true);
  assert.notEqual(refreshed.body.token, oldToken);
  assert.equal(tokenService.verify(refreshed.body.token).user.phone_verified, true);
  assert.deepEqual(redis.entries.get('lanlink:auth:refresh:9'), { count: 1, ttl: 60 });
});

test('POST /api/auth/login：ESA 转发的客户端 IP 使用独立限流桶', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const redis = createFakeRedis();
  let forumCalls = 0;
  const forumClient = {
    async validateUsernamePassword(username) {
      forumCalls += 1;
      return { id: forumCalls, username, role: 'user', phone_verified: true, token_version: 1 };
    }
  };
  const server = await startAuthServer({ forumClient, tokenService, redis });
  t.after(() => server.close());

  const login = (username, forwardedFor) => request(
    server.port,
    'POST',
    '/api/auth/login',
    { username, password: 'password' },
    '',
    { 'X-Forwarded-For': forwardedFor }
  );

  for (let index = 0; index < 30; index += 1) {
    const response = await login(`user-${index}`, '203.0.113.10, 198.51.100.8');
    assert.equal(response.statusCode, 200);
  }

  const blocked = await login('blocked-user', '203.0.113.10, 198.51.100.8');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.code, 'rate_limited');
  assert.equal(blocked.body.message, '登录尝试过于频繁，请稍后再试');

  const independent = await login('other-user', '203.0.113.11');
  assert.equal(independent.statusCode, 200);

  const normalizedUser = await login('Alice', '203.0.113.12');
  assert.equal(normalizedUser.statusCode, 200);
  assert.equal(forumCalls, 32);
  assert.deepEqual(redis.entries.get('lanlink:login:ip:203.0.113.10'), { count: 31, ttl: 60 });
  assert.deepEqual(redis.entries.get('lanlink:login:ip:203.0.113.11'), { count: 1, ttl: 60 });
  assert.deepEqual(redis.entries.get('lanlink:login:user:alice'), { count: 1, ttl: 60 });
});

// ========== POST /api/auth/login ==========

test('POST /api/auth/login：成功登录返回 token', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const forumClient = {
    async validateUsernamePassword(username, password) {
      if (username === 'alice' && password === 'correct') {
        return { id: 1, username: 'alice', role: 'user', phone_verified: true, token_version: 1 };
      }
      return null;
    }
  };
  const server = await startAuthServer({ forumClient, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/login', { username: 'alice', password: 'correct' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.token);
  assert.equal(res.body.user.username, 'alice');
  assert.equal(res.body.user.phone_verified, true);
  assert.ok(res.body.expires_in > 0);
});

test('POST /api/auth/login：错误密码返回 401', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const forumClient = { async validateUsernamePassword() { return null; } };
  const server = await startAuthServer({ forumClient, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/login', { username: 'alice', password: 'wrong' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'invalid_credentials');
});

test('POST /api/auth/login：缺少字段返回 400', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const server = await startAuthServer({ forumClient: {}, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res1 = await request(server.port, 'POST', '/api/auth/login', {});
  assert.equal(res1.statusCode, 400);
  assert.equal(res1.body.code, 'missing_credentials');

  const res2 = await request(server.port, 'POST', '/api/auth/login', { username: 'alice' });
  assert.equal(res2.statusCode, 400);
});

test('POST /api/auth/login：论坛服务异常返回 502', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const forumClient = { async validateUsernamePassword() { throw new Error('Forum down'); } };
  const server = await startAuthServer({ forumClient, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/login', { username: 'alice', password: 'pass' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'forum_error');
});

test('POST /api/auth/login：服务未配置返回 503', async (t) => {
  const server = await startAuthServer({ forumClient: null, tokenService: null, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/login', { username: 'a', password: 'b' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'auth_unavailable');
});

test('POST /api/auth/login：dev 模式 type 标记为 dev', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const forumClient = {
    devMode: true,
    async validateUsernamePassword() {
      return { id: 1, username: 'devuser', role: 'admin', phone_verified: true };
    }
  };
  const server = await startAuthServer({ forumClient, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/login', { username: 'devuser', password: 'pass' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.type, 'dev');
});

// ========== GET /api/auth/me ==========

test('GET /api/auth/me：有效 token 返回用户信息', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const token = tokenService.issue({ id: 1, username: 'alice', role: 'user', phone_verified: true });
  const server = await startAuthServer({ forumClient: {}, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'GET', '/api/auth/me', null, token);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.user.username, 'alice');
});

test('GET /api/auth/me：无效 token 返回 401', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const server = await startAuthServer({ forumClient: {}, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'GET', '/api/auth/me', null, 'invalid-token');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'auth_invalid');
});

test('GET /api/auth/me：无 token 返回 401', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const server = await startAuthServer({ forumClient: {}, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'GET', '/api/auth/me');
  assert.equal(res.statusCode, 401);
});

// ========== POST /api/auth/code/exchange 补充 ==========

test('POST /api/auth/code/exchange：缺少 code 返回 400', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const server = await startAuthServer({ forumClient: {}, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/code/exchange', {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid_code');
});

test('POST /api/auth/code/exchange：服务未配置返回 503', async (t) => {
  const server = await startAuthServer({ forumClient: null, tokenService: null, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/code/exchange', { code: 'LL-TEST-1234' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'auth_unavailable');
});

test('POST /api/auth/code/exchange：论坛异常返回 502', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const forumClient = { async exchangeQuickCode() { throw new Error('Forum error'); } };
  const server = await startAuthServer({ forumClient, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/code/exchange', { code: 'LL-TEST-1234' });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'forum_error');
});

// ========== POST /api/auth/refresh 补充 ==========

test('POST /api/auth/refresh：无效 token 返回 401', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const server = await startAuthServer({ forumClient: {}, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/refresh', null, 'bad-token');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'auth_invalid');
});

test('POST /api/auth/refresh：用户不存在返回 401', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const token = tokenService.issue({ id: 99, username: 'ghost', role: 'user' });
  const forumClient = { async getLanLinkUser() { return null; } };
  const server = await startAuthServer({ forumClient, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/refresh', null, token);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'user_not_found');
});

test('POST /api/auth/refresh：论坛异常返回 502', async (t) => {
  const tokenService = createTokenService({ secret: 'test-auth-secret-long-enough', ttlSeconds: 60 });
  const token = tokenService.issue({ id: 1, username: 'alice', role: 'user' });
  const forumClient = { async getLanLinkUser() { throw new Error('Forum down'); } };
  const server = await startAuthServer({ forumClient, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());

  const res = await request(server.port, 'POST', '/api/auth/refresh', null, token);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'forum_error');
});
