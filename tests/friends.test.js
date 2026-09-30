'use strict';

/**
 * 好友 / 邀请路由测试。
 *
 * 覆盖：GET /friends, GET /friends/requests, POST /invites/send, POST /invites/respond
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const Router = require('@koa/router');
const { createTokenService } = require('../src/auth/tokenService');

function request(port, method, path, body = null, token = '') {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null });
        } catch {
          resolve({ statusCode: res.statusCode, body: text });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function createFakeRedis() {
  const store = new Map();
  return {
    store,
    async set(key, value) { store.set(key, value); return 'OK'; },
    async get(key) { return store.get(key) || null; },
    async del(key) { store.delete(key); return 1; }
  };
}

function createFakeRegistry(rooms = {}) {
  return {
    get(code) { return rooms[code.toUpperCase()] || rooms[code] || null; }
  };
}

/**
 * 注入 fake redis 到 require.cache，然后 require friends 路由。
 * 每次调用返回全新的路由模块，确保 services 隔离。
 */
function loadFriendsWithRedis(redis) {
  const fakeModulePath = require.resolve('../src/db/redis');
  const original = require.cache[fakeModulePath];
  require.cache[fakeModulePath] = {
    id: fakeModulePath,
    filename: fakeModulePath,
    loaded: true,
    exports: { redis, default: redis }
  };

  // 清除 friends 路由缓存，让它重新 require redis
  const friendsPath = require.resolve('../src/routes/friends');
  delete require.cache[friendsPath];

  const friendsRoute = require('../src/routes/friends');

  return {
    friendsRoute,
    restore() {
      if (original) {
        require.cache[fakeModulePath] = original;
      } else {
        delete require.cache[fakeModulePath];
      }
    }
  };
}

async function startServer({ forumClient, tokenService, presenceService, registry, redis }) {
  const { friendsRoute, restore } = loadFriendsWithRedis(redis);
  friendsRoute.setFriendsServices({ forumClient, tokenService, presenceService, registry });

  const app = new Koa();
  app.use(bodyParser());
  const router = new Router({ prefix: '/api' });
  router.use(friendsRoute.router.routes(), friendsRoute.router.allowedMethods());
  app.use(router.routes());
  app.use(router.allowedMethods());

  const server = http.createServer(app.callback());
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return {
    port,
    close: () => { server.close(); restore(); }
  };
}

const tokenService = createTokenService({ secret: 'test-secret-key-for-friends-test', ttlSeconds: 60 });
const testUser = { id: '1', username: 'alice', role: 'user', phone_verified: true };
const testToken = tokenService.issue(testUser);

// ========== GET /api/friends ==========

test('GET /api/friends：未登录返回 401', async (t) => {
  const server = await startServer({ forumClient: {}, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());
  const res = await request(server.port, 'GET', '/api/friends');
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'auth_required');
});

test('GET /api/friends：论坛未配置返回 503', async (t) => {
  const server = await startServer({ forumClient: null, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());
  const res = await request(server.port, 'GET', '/api/friends', null, testToken);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'forum_unavailable');
});

test('GET /api/friends：无好友返回空列表', async (t) => {
  const server = await startServer({
    forumClient: { async getFriends() { return { friends: [] }; } },
    tokenService,
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'GET', '/api/friends', null, testToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.friends, []);
});

test('GET /api/friends：返回好友列表 + presence', async (t) => {
  const friends = [
    { id: '2', username: 'bob', display_name: 'Bob' },
    { id: '3', username: 'carol', display_name: 'Carol' }
  ];
  const presences = {
    '2': { status: 'online' },
    '3': { status: 'hosting', room_code: 'MDT-ABC123' }
  };
  const server = await startServer({
    forumClient: {
      async getFriends() { return { friends }; },
      async getFriendPresences() { return { presences }; }
    },
    tokenService,
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'GET', '/api/friends', null, testToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.friends.length, 2);
  assert.equal(res.body.friends[0].presence.status, 'online');
  assert.equal(res.body.friends[1].presence.status, 'hosting');
});

test('GET /api/friends：presence 失败不影响好友列表', async (t) => {
  const server = await startServer({
    forumClient: {
      async getFriends() { return { friends: [{ id: '2', username: 'bob' }] }; },
      async getFriendPresences() { throw new Error('Forum down'); }
    },
    tokenService,
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'GET', '/api/friends', null, testToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.friends[0].presence.status, 'offline');
});

// ========== GET /api/friends/requests ==========

test('GET /api/friends/requests：返回待处理请求', async (t) => {
  const server = await startServer({
    forumClient: {
      async getFriendRequests() { return { requests: [{ from_user_id: '5', username: 'eve' }] }; }
    },
    tokenService,
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'GET', '/api/friends/requests', null, testToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.requests.length, 1);
});

test('GET /api/friends/requests：未登录返回 401', async (t) => {
  const server = await startServer({ forumClient: {}, tokenService, redis: createFakeRedis() });
  t.after(() => server.close());
  const res = await request(server.port, 'GET', '/api/friends/requests');
  assert.equal(res.statusCode, 401);
});

// ========== POST /api/invites/send ==========

test('POST /api/invites/send：缺少参数返回 400', async (t) => {
  const server = await startServer({
    forumClient: {},
    tokenService,
    registry: createFakeRegistry(),
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/send', {}, testToken);
  assert.equal(res.statusCode, 400);
});

test('POST /api/invites/send：房间不存在返回 404', async (t) => {
  const server = await startServer({
    forumClient: {},
    tokenService,
    registry: createFakeRegistry({}),
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/send', {
    room_code: 'MDT-NONE',
    friend_user_id: '2'
  }, testToken);
  assert.equal(res.statusCode, 404);
});

test('POST /api/invites/send：非房主返回 403', async (t) => {
  const room = {
    code: 'MDT-ABC123',
    roomPort: 24001,
    ownerWs: {},
    owner: { id: '99', username: 'other' }
  };
  const server = await startServer({
    forumClient: {},
    tokenService,
    registry: createFakeRegistry({ 'MDT-ABC123': room }),
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/send', {
    room_code: 'MDT-ABC123',
    friend_user_id: '2'
  }, testToken);
  assert.equal(res.statusCode, 403);
});

test('POST /api/invites/send：非好友返回 403', async (t) => {
  const room = {
    code: 'MDT-ABC123',
    roomPort: 24001,
    name: 'Test',
    displayName: 'Test',
    nodeName: 'Node1',
    ownerWs: {},
    owner: { id: '1', username: 'alice' }
  };
  const server = await startServer({
    forumClient: { async checkFriendship() { return false; } },
    tokenService,
    registry: createFakeRegistry({ 'MDT-ABC123': room }),
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/send', {
    room_code: 'MDT-ABC123',
    friend_user_id: '2'
  }, testToken);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.message, '只能邀请好友');
});

test('POST /api/invites/send：成功发送邀请', async (t) => {
  const room = {
    code: 'MDT-ABC123',
    roomPort: 24001,
    name: 'Test',
    displayName: 'Test',
    nodeName: 'Node1',
    ownerWs: {},
    owner: { id: '1', username: 'alice' }
  };
  const redis = createFakeRedis();
  const server = await startServer({
    forumClient: {
      async checkFriendship() { return true; },
      async sendNotification() { return true; }
    },
    tokenService,
    registry: createFakeRegistry({ 'MDT-ABC123': room }),
    redis
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/send', {
    room_code: 'MDT-ABC123',
    friend_user_id: '2'
  }, testToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  // 验证 Redis 写入了邀请
  assert.ok(redis.store.has('lanlink:invite:2:MDT-ABC123'));
});

// ========== POST /api/invites/respond ==========

test('POST /api/invites/respond：缺少参数返回 400', async (t) => {
  const server = await startServer({
    forumClient: {},
    tokenService,
    registry: createFakeRegistry(),
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/respond', {}, testToken);
  assert.equal(res.statusCode, 400);
});

test('POST /api/invites/respond：邀请不存在返回 404', async (t) => {
  const server = await startServer({
    forumClient: {},
    tokenService,
    registry: createFakeRegistry(),
    redis: createFakeRedis()
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/respond', {
    room_code: 'MDT-NONE',
    action: 'accept'
  }, testToken);
  assert.equal(res.statusCode, 404);
});

test('POST /api/invites/respond：接受邀请返回房间信息', async (t) => {
  const room = {
    code: 'MDT-ABC123',
    roomPort: 24001,
    name: 'Test',
    displayName: 'Test',
    nodeId: 'node-1',
    nodeName: 'Node1',
    nodeAddr: '1.2.3.4',
    tunnelPort: 20000
  };
  const redis = createFakeRedis();
  redis.store.set('lanlink:invite:1:MDT-ABC123', JSON.stringify({ from_user_id: '99' }));
  const server = await startServer({
    forumClient: {},
    tokenService,
    registry: createFakeRegistry({ 'MDT-ABC123': room }),
    redis
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/respond', {
    room_code: 'MDT-ABC123',
    action: 'accept'
  }, testToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.room.code, 'MDT-ABC123');
  assert.equal(res.body.room.node.id, 'node-1');
  // 邀请已删除
  assert.equal(redis.store.has('lanlink:invite:1:MDT-ABC123'), false);
});

test('POST /api/invites/respond：拒绝邀请删除 Redis', async (t) => {
  const redis = createFakeRedis();
  redis.store.set('lanlink:invite:1:MDT-XYZ789', JSON.stringify({ from_user_id: '99' }));
  const server = await startServer({
    forumClient: {},
    tokenService,
    registry: createFakeRegistry(),
    redis
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/respond', {
    room_code: 'MDT-XYZ789',
    action: 'decline'
  }, testToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(redis.store.has('lanlink:invite:1:MDT-XYZ789'), false);
});

test('POST /api/invites/respond：无效 action 返回 400', async (t) => {
  const redis = createFakeRedis();
  redis.store.set('lanlink:invite:1:MDT-ABC123', JSON.stringify({ from_user_id: '99' }));
  const server = await startServer({
    forumClient: {},
    tokenService,
    registry: createFakeRegistry(),
    redis
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/respond', {
    room_code: 'MDT-ABC123',
    action: 'invalid'
  }, testToken);
  assert.equal(res.statusCode, 400);
});

test('POST /api/invites/respond：接受邀请但房间已关闭返回 404', async (t) => {
  const redis = createFakeRedis();
  redis.store.set('lanlink:invite:1:MDT-ABC123', JSON.stringify({ from_user_id: '99' }));
  const server = await startServer({
    forumClient: {},
    tokenService,
    registry: createFakeRegistry({}), // 房间不存在
    redis
  });
  t.after(() => server.close());
  const res = await request(server.port, 'POST', '/api/invites/respond', {
    room_code: 'MDT-ABC123',
    action: 'accept'
  }, testToken);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, '房间已关闭');
});
