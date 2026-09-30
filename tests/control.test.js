'use strict';

/**
 * 控制面 WS 流程测试（mock 节点 + mock mod）：
 * register / heartbeat / create_room / room_ok / close_room / 60s 宽限
 * （定时器注入缩短）/ resume 恢复 / 错误码。
 *
 * 不依赖真实 MySQL/Redis：persistence 用注入（bandwidth 断言）或不注入（跳过）。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');

const routes = require('../src/routes');
const nodesRoute = require('../src/routes/nodes');
const roomsRoute = require('../src/routes/rooms');
const adminRoute = require('../src/routes/admin');
const { createRoomRegistry } = require('../src/control/roomRegistry');
const { createNodeGateway } = require('../src/control/nodeSocket');
const { createModGateway } = require('../src/control/modSocket');
const nodePicker = require('../src/control/nodePicker');
const { createTokenService } = require('../src/auth/tokenService');

const quietLog = { log() {}, warn() {}, error() {} };
const CODE_RE = /^MDT-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 起一个进程内控制面（HTTP + /ws/mod + /ws/node + /ws/guest），定时器可注入缩短 */
async function startControl({
  tokens = ['tok-1'],
  tokenMap = null,
  graceMs = 60000,
  heartbeatTimeoutMs = 60000,
  sweepMs = 60000,
  openTimeoutMs = 2000,
  writeBandwidth = null,
  tokenService = null,
  accessConfig = null,
  forumClient = null,
  verificationPageUrl = 'https://forum.example.com/verify-phone'
} = {}) {
  const app = new Koa();
  app.use(bodyParser({ json: { limit: '1mb' } }));
  app.use(routes.routes());
  app.use(routes.allowedMethods());

  const server = http.createServer(app.callback());
  const modWss = new WebSocketServer({ noServer: true });
  const nodeWss = new WebSocketServer({ noServer: true });
  const guestWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/ws/mod') {
      modWss.handleUpgrade(req, socket, head, (ws) => modWss.emit('connection', ws, req));
    } else if (pathname === '/ws/node') {
      nodeWss.handleUpgrade(req, socket, head, (ws) => nodeWss.emit('connection', ws, req));
    } else if (pathname === '/ws/guest') {
      guestWss.handleUpgrade(req, socket, head, (ws) => guestWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  const registry = createRoomRegistry({ graceMs, log: quietLog });
  const nodeGateway = createNodeGateway({
    wss: nodeWss,
    tokens,
    tokenMap,
    registry,
    heartbeatTimeoutMs,
    sweepMs,
    openTimeoutMs,
    persistence: writeBandwidth ? { writeBandwidth } : null,
    log: quietLog
  });
  createModGateway({
    wss: modWss,
    registry,
    nodeGateway,
    picker: nodePicker,
    tokenService,
    accessConfig,
    settings: { protocolVersion: 2, motd: '测试 MOTD', latest: '0.13.0', serverVersion: '0.13.0', downloadUrl: 'https://example.com/dl', verificationPageUrl },
    log: quietLog
  });
  const { createGuestGateway } = require('../src/control/guestSocket');
  const guestGateway = createGuestGateway({
    wss: guestWss,
    registry,
    tokenService,
    settings: { serverVersion: '0.13.0', motd: '测试 MOTD', latest: '0.13.0', protocolVersion: 2, downloadUrl: 'https://example.com/dl', verificationPageUrl },
    log: quietLog
  });
  const origOnDestroy = registry.onDestroy;
  registry.onDestroy = (room, reason) => {
    if (guestGateway && typeof guestGateway.onRoomDestroyed === 'function') {
      guestGateway.onRoomDestroyed(room);
    }
    if (typeof origOnDestroy === 'function') origOnDestroy(room, reason);
  };
  nodesRoute.setNodeLister(() => nodeGateway.onlineNodes());
  nodesRoute.setNodeAccessServices({ tokenService, accessConfig });
  roomsRoute.setRoomLookup((code) => registry.get(code));
  roomsRoute.setRoomLister(() => registry.all());
  adminRoute.setAdminServices({ forumClient, registry, nodeGateway });

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    port,
    registry,
    nodeGateway,
    close() {
      nodeGateway.close();
      for (const ws of modWss.clients) ws.terminate();
      for (const ws of nodeWss.clients) ws.terminate();
      for (const ws of guestWss.clients) ws.terminate();
      server.close();
    }
  };
}

/** WS 客户端封装：消息队列 + 按序取下一条 */
function wsClient(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  return {
    ws,
    ready: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    closed: new Promise((resolve) => ws.once('close', resolve)),
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    next(timeoutMs = 2000) {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(onMsg);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('等待 WS 消息超时'));
        }, timeoutMs);
        const onMsg = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
        waiters.push(onMsg);
      });
    },
    /** 返回当前积压的消息（不等待） */
    drained() {
      return queue.splice(0);
    },
    close() {
      ws.close();
    }
  };
}

async function fetchJson(port, path, auth = '') {
  // auth 可以是 bearer token 字符串，也可以是 headers 对象（如 { 'x-forum-session': '...' }）
  const headers = typeof auth === 'string'
    ? (auth ? { Authorization: `Bearer ${auth}` } : {})
    : (auth || {});
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path,
      headers
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: body ? JSON.parse(body) : null });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
  });
}

async function postJson(port, path, body = {}, forumSession = '') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(forumSession ? { 'x-forum-session': forumSession } : {})
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function deleteJson(port, path, forumSession = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(forumSession ? { 'x-forum-session': forumSession } : {})
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function registerNode(ctl, token = 'tok-1', extra = {}) {
  const node = wsClient(`ws://127.0.0.1:${ctl.port}/ws/node`);
  await node.ready;
  node.send({ op: 'register', ver: 2, token, name: '上海节点', addr: '1.2.3.4', tunnel_port: 20000, port_range: [20001, 20099], mbps: 30, ...extra });
  const regOk = await node.next();
  assert.equal(regOk.op, 'register_ok');
  return { node, id: regOk.id };
}

async function helloMod(ctl, extra = {}) {
  const mod = wsClient(`ws://127.0.0.1:${ctl.port}/ws/mod`);
  await mod.ready;
  mod.send({ op: 'hello', ver: 2, build: 146, platform: 'desktop', mod_version: '0.1.0', token: '', ...extra });
  return mod;
}

/** 完整开房：mod 发 create_room，node 回 room_opened，返回 room_ok */
async function createRoom(mod, node, roomPort = 23456, extra = {}) {
  mod.send({ op: 'create_room', name: '周末打波', public: false, vanilla_join: true, game_port: 6567, ...extra });
  const openReq = await node.next();
  assert.equal(openReq.op, 'open_room');
  node.send({ op: 'room_opened', code: openReq.code, room_port: roomPort });
  const roomOk = await mod.next();
  assert.equal(roomOk.op, 'room_ok');
  return { openReq, roomOk };
}

test('GET /api/nodes/available：返回在线节点白名单摘要', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  await registerNode(ctl, 'tok-1', {
    name: '上海节点',
    addr: '1.2.3.4',
    tunnel_port: 20000
  });

  const res = await fetchJson(ctl.port, '/api/nodes/available');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    nodes: [{
      id: 'node-1',
      name: '上海节点',
      addr: '1.2.3.4',
      tunnel_port: 20000,
      rooms: 0,
      sessions: 0,
      mbps_used: 0,
      access: 'anonymous',
      requires_login: false,
      usable: true,
      reason: '',
      region: '',
      tags: [],
      official: true,
      owner: '',
      description: ''
    }]
  });
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.nodes[0], 'token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.nodes[0], 'port_range'), false);
});

test('节点权限：未登录可见登录节点但不能使用，登录后可用', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const accessConfig = { defaultAccess: 'anonymous', nodes: { 'node-2': { access: 'login' } } };
  const ctl = await startControl({ tokens: ['tok-1', 'tok-2'], tokenService, accessConfig });
  t.after(() => ctl.close());

  await registerNode(ctl, 'tok-1', { name: '匿名节点', addr: '1.1.1.1', tunnel_port: 20000 });
  const { node: loginNode } = await registerNode(ctl, 'tok-2', { name: '登录节点', addr: '2.2.2.2', tunnel_port: 21000 });

  const anonList = await fetchJson(ctl.port, '/api/nodes/available');
  assert.equal(anonList.statusCode, 200);
  const anonLoginNode = anonList.body.nodes.find((node) => node.id === 'node-2');
  assert.equal(anonLoginNode.requires_login, true);
  assert.equal(anonLoginNode.usable, false);
  assert.equal(anonLoginNode.reason, 'login_required');

  const anonMod = await helloMod(ctl);
  assert.equal((await anonMod.next()).op, 'hello_ok');
  anonMod.send({ op: 'create_room', name: 'x', public: false, vanilla_join: true, game_port: 6567, node_id: 'node-2' });
  const forbidden = await anonMod.next();
  assert.equal(forbidden.op, 'error');
  assert.equal(forbidden.code, 'node_forbidden');

  const token = tokenService.issue({ id: 42, username: 'alice', role: 'user', phone_verified: true });
  const authList = await fetchJson(ctl.port, '/api/nodes/available', token);
  const authLoginNode = authList.body.nodes.find((node) => node.id === 'node-2');
  assert.equal(authLoginNode.usable, true);
  assert.equal(authLoginNode.reason, '');

  const authMod = await helloMod(ctl, { token });
  const helloOk = await authMod.next();
  assert.equal(helloOk.op, 'hello_ok');
  assert.equal(helloOk.user.username, 'alice');
  const { roomOk } = await createRoom(authMod, loginNode, 24567, { node_id: 'node-2' });
  assert.equal(roomOk.node.id, 'node-2');
});
test('GET /api/rooms/:code：用房间码解析原版加入地址', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl, 'tok-1', {
    name: '上海节点',
    addr: '1.2.3.4',
    tunnel_port: 20000
  });
  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');
  const { roomOk } = await createRoom(mod, node, 23456);

  const res = await fetchJson(ctl.port, `/api/rooms/${roomOk.code}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    code: roomOk.code,
    name: '周末打波',
    display_name: '[green]MDTBBS>LL[orange] M0.1.0/S0.13.0[purple] 上海节点',
    public: false,
    owner: { type: 'anonymous', display_name: '匿名房主' },
    node: {
      id: 'node-1',
      name: '上海节点',
      addr: '1.2.3.4',
      room_port: 23456
    }
  });
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'room_token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.node, 'tunnel_port'), false);

  const missing = await fetchJson(ctl.port, '/api/rooms/MDT-NOT999');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.success, false);
});

test('GET /api/rooms/:code：返回合法 direct 候选并过滤非法 direct', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl, 'tok-1', {
    name: '上海节点',
    addr: '1.2.3.4',
    tunnel_port: 20000
  });
  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');
  const { roomOk } = await createRoom(mod, node, 23456, {
    direct: { mode: 'upnp', addr: '8.8.8.8', tcp_port: 6567, udp_port: 6567 }
  });

  const res = await fetchJson(ctl.port, `/api/rooms/${roomOk.code}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.direct, { mode: 'upnp', addr: '8.8.8.8', port: 6567 });

  mod.send({ op: 'close_room' });
  assert.equal((await node.next()).op, 'close_room');
  assert.equal((await mod.next()).op, 'room_closed');

  const mod2 = await helloMod(ctl);
  assert.equal((await mod2.next()).op, 'hello_ok');
  const { roomOk: badRoomOk } = await createRoom(mod2, node, 23457, {
    direct: { mode: 'upnp', addr: '8.8.4.4', tcp_port: 6567, udp_port: 6568 }
  });
  const bad = await fetchJson(ctl.port, `/api/rooms/${badRoomOk.code}`);
  assert.equal(bad.statusCode, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(bad.body, 'direct'), false);
});
test('GET /api/rooms/public：只返回未隐藏的公开房间并标记匿名房主', async (t) => {
  const forumClient = { async verifyForumSession() { return { id: 1, username: 'admin', role: 'admin' }; } };
  const ctl = await startControl({ forumClient });
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl);
  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');
  const { roomOk } = await createRoom(mod, node, 23456, { public: true });

  const list = await fetchJson(ctl.port, '/api/rooms/public');
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.rooms.length, 1);
  assert.equal(list.body.rooms[0].code, roomOk.code);
  assert.equal(list.body.rooms[0].public, true);
  assert.deepEqual(list.body.rooms[0].owner, { type: 'anonymous', display_name: '匿名房主' });
  assert.equal(Object.prototype.hasOwnProperty.call(list.body.rooms[0], 'room_token'), false);

  const hidden = await postJson(ctl.port, `/api/admin/rooms/${roomOk.code}/hide`, { reason: 'bad_name' }, 'admin-session');
  assert.equal(hidden.statusCode, 200);
  assert.equal(hidden.body.ok, true);

  const afterHide = await fetchJson(ctl.port, '/api/rooms/public');
  assert.equal(afterHide.body.rooms.length, 0);
});
test('GET /api/rooms/public：只有显式布尔 true 才授权论坛公开', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl);

  const privateMod = await helloMod(ctl);
  assert.equal((await privateMod.next()).op, 'hello_ok');
  await createRoom(privateMod, node, 23456, { public: false });

  const malformedMod = await helloMod(ctl);
  assert.equal((await malformedMod.next()).op, 'hello_ok');
  await createRoom(malformedMod, node, 23457, { public: 'true' });

  const list = await fetchJson(ctl.port, '/api/rooms/public');
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body.rooms, []);
});
test('create_room：带 node_id 时命中指定节点', async (t) => {
  const ctl = await startControl({ tokens: ['tok-1', 'tok-2'] });
  t.after(() => ctl.close());

  await registerNode(ctl, 'tok-1', { name: '上海节点', addr: '1.1.1.1', tunnel_port: 20000 });
  const { node: node2 } = await registerNode(ctl, 'tok-2', { name: '杭州节点', addr: '2.2.2.2', tunnel_port: 21000 });

  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');

  const { roomOk } = await createRoom(mod, node2, 24567, { node_id: 'node-2' });
  assert.equal(roomOk.node.id, 'node-2');
  assert.equal(roomOk.node.name, '杭州节点');
  assert.equal(roomOk.node.addr, '2.2.2.2');
  assert.equal(roomOk.node.tunnel_port, 21000);
  assert.equal(roomOk.node.room_port, 24567);
});

test('create_room：带 relay_addr + relay_tunnel_port 时匹配指定节点', async (t) => {
  const ctl = await startControl({ tokens: ['tok-1', 'tok-2'] });
  t.after(() => ctl.close());

  await registerNode(ctl, 'tok-1', { name: '上海节点', addr: '1.1.1.1', tunnel_port: 20000 });
  const { node: node2 } = await registerNode(ctl, 'tok-2', { name: '杭州节点', addr: '2.2.2.2', tunnel_port: 21000 });

  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');

  const { roomOk } = await createRoom(mod, node2, 25567, {
    relay_addr: '2.2.2.2',
    relay_tunnel_port: 21000
  });
  assert.equal(roomOk.node.id, 'node-2');
  assert.equal(roomOk.node.name, '杭州节点');
  assert.equal(roomOk.node.addr, '2.2.2.2');
});

test('create_room：指定不存在节点返回 node_not_found，不回退自动选点', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  await registerNode(ctl, 'tok-1', { name: '上海节点', addr: '1.1.1.1', tunnel_port: 20000 });
  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');

  mod.send({ op: 'create_room', name: 'x', public: false, vanilla_join: true, game_port: 6567, node_id: 'node-404' });
  const err = await mod.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'node_not_found');
});

test('create_room：多节点且未指定时仍回退自动选点', async (t) => {
  const ctl = await startControl({ tokens: ['tok-1', 'tok-2'] });
  t.after(() => ctl.close());

  const { node: node1 } = await registerNode(ctl, 'tok-1', { name: '上海节点', addr: '1.1.1.1', tunnel_port: 20000 });
  const { node: node2 } = await registerNode(ctl, 'tok-2', { name: '杭州节点', addr: '2.2.2.2', tunnel_port: 21000 });
  node1.send({ op: 'heartbeat', rooms: 3, sessions: 4, mbps_used: 9.5 });
  node2.send({ op: 'heartbeat', rooms: 1, sessions: 2, mbps_used: 3.5 });

  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');

  const { roomOk } = await createRoom(mod, node2, 26567);
  assert.equal(roomOk.node.id, 'node-2');
  assert.equal(roomOk.node.name, '杭州节点');
});

test('register + hello + create_room + close_room 全流程', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const { node, id } = await registerNode(ctl);
  assert.equal(id, 'node-1');

  const mod = await helloMod(ctl);
  const helloOk = await mod.next();
  assert.equal(helloOk.op, 'hello_ok');
  assert.equal(helloOk.motd, '测试 MOTD');
  assert.equal(helloOk.latest, '0.13.0');
  assert.equal(helloOk.server_version, '0.13.0');

  const { openReq, roomOk } = await createRoom(mod, node);
  assert.match(openReq.code, CODE_RE, '房间码格式 MDT-XXXXXX（剔除 0O1I）');
  assert.match(openReq.room_token, /^[0-9a-f]{32}$/, 'roomToken = 32 字符 hex');
  assert.equal(roomOk.code, openReq.code);
  assert.equal(roomOk.room_token, openReq.room_token);
  assert.equal(roomOk.display_name, '[green]MDTBBS>LL[orange] M0.1.0/S0.13.0[purple] 上海节点');
  assert.equal(roomOk.mod_version, '0.1.0');
  assert.equal(roomOk.server_version, '0.13.0');
  assert.deepEqual(roomOk.node, { id: 'node-1', name: '上海节点', addr: '1.2.3.4', room_port: 23456, tunnel_port: 20000 });
  assert.ok(ctl.registry.get(openReq.code), '控制面应登记房间');

  // ping/pong
  mod.send({ op: 'ping' });
  assert.equal((await mod.next()).op, 'pong');

  // 主动关房
  mod.send({ op: 'close_room' });
  const closeReq = await node.next();
  assert.equal(closeReq.op, 'close_room');
  assert.equal(closeReq.code, openReq.code);
  const closed = await mod.next();
  assert.equal(closed.op, 'room_closed');
  assert.equal(closed.reason, 'owner');
  assert.equal(ctl.registry.get(openReq.code), undefined);
});

test('展示字段：旧节点和旧 Mod 缺省字段时降级但仍可开房', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl, 'tok-1', { name: undefined });
  const mod = await helloMod(ctl, { mod_version: undefined });
  const helloOk = await mod.next();
  assert.equal(helloOk.op, 'hello_ok');
  assert.equal(helloOk.server_version, '0.13.0');

  const { roomOk } = await createRoom(mod, node);
  assert.equal(roomOk.node.name, 'node-1');
  assert.equal(roomOk.mod_version, '');
  assert.equal(roomOk.server_version, '0.13.0');
  assert.equal(roomOk.display_name, '[green]MDTBBS>LL[orange] M?/S0.13.0[purple] node-1');
});

test('register：token 不在白名单被拒绝并断开', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const node = wsClient(`ws://127.0.0.1:${ctl.port}/ws/node`);
  await node.ready;
  node.send({ op: 'register', ver: 2, token: 'bad-token', name: '坏节点', addr: '1.2.3.4', tunnel_port: 20000, port_range: [20001, 20099], mbps: 30 });
  const err = await node.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'auth_failed');
  await node.closed;
});

test('hello：过旧 ver 返回 upgrade_required + 下载链接', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const mod = wsClient(`ws://127.0.0.1:${ctl.port}/ws/mod`);
  await mod.ready;
  mod.send({ op: 'hello', ver: 1, build: 100, platform: 'desktop', token: '' });
  const err = await mod.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'upgrade_required');
  assert.equal(err.url, 'https://example.com/dl');
  assert.equal(err.required_version, 2);
  await mod.closed;
});

test('create_room：无在线节点返回 no_node；未 hello 返回 invalid_op', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');
  mod.send({ op: 'create_room', name: 'x', public: false, vanilla_join: true, game_port: 6567 });
  const err = await mod.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'no_node');

  const mod2 = wsClient(`ws://127.0.0.1:${ctl.port}/ws/mod`);
  await mod2.ready;
  mod2.send({ op: 'create_room', name: 'x', public: false, vanilla_join: true, game_port: 6567 });
  const err2 = await mod2.next();
  assert.equal(err2.op, 'error');
  assert.equal(err2.code, 'invalid_op');
  mod2.close();
});

test('heartbeat：room_stat 随心跳批量落库', async (t) => {
  let resolveRows;
  const captured = new Promise((resolve) => { resolveRows = resolve; });
  const ctl = await startControl({ writeBandwidth: (rows) => resolveRows(rows) });
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl);
  node.send({ op: 'room_stat', code: 'MDT-ABC234', conns: 2, rx: 123456, tx: 654321 });
  node.send({ op: 'room_stat', code: 'MDT-DEF567', conns: 1, rx: 5, tx: 6 });
  node.send({ op: 'heartbeat', rooms: 2, sessions: 3, mbps_used: 8.5 });

  const rows = await captured;
  assert.equal(rows.length, 2, '每心跳批量写入');
  assert.deepEqual(rows[0], { nodeId: 'node-1', code: 'MDT-ABC234', conns: 2, rx: 123456, tx: 654321 });
  assert.deepEqual(rows[1], { nodeId: 'node-1', code: 'MDT-DEF567', conns: 1, rx: 5, tx: 6 });
});

test('房主断线：宽限期（注入 200ms）超时销毁房间并通知节点', async (t) => {
  const ctl = await startControl({ graceMs: 200 });
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl);
  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');
  const { openReq } = await createRoom(mod, node);

  mod.close();
  const closeReq = await node.next(2000);
  assert.equal(closeReq.op, 'close_room');
  assert.equal(closeReq.code, openReq.code);
  assert.equal(ctl.registry.get(openReq.code), undefined, '宽限超时后房间应销毁');
});

test('房主断线：宽限期内携 resume 恢复房间', async (t) => {
  const ctl = await startControl({ graceMs: 400 });
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl);
  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');
  const { openReq } = await createRoom(mod, node);

  mod.close();
  await delay(50); // 让服务端感知断开、进入宽限

  const mod2 = await helloMod(ctl, { resume: openReq.room_token });
  assert.equal((await mod2.next()).op, 'hello_ok');
  const resumed = await mod2.next();
  assert.equal(resumed.op, 'room_ok', 'resume 成功应补发 room_ok');
  assert.equal(resumed.code, openReq.code);
  assert.equal(resumed.room_token, openReq.room_token);
  assert.equal(resumed.node.room_port, 23456);
  assert.equal(resumed.node.name, '上海节点');
  assert.equal(resumed.display_name, '[green]MDTBBS>LL[orange] M0.1.0/S0.13.0[purple] 上海节点');

  // 越过原宽限期，房间应仍在、节点不应收到 close_room
  await delay(600);
  assert.ok(ctl.registry.get(openReq.code), 'resume 后房间不应被宽限定时器销毁');
  const stray = node.drained().filter((m) => m.op === 'close_room');
  assert.equal(stray.length, 0, 'resume 后不应给节点发 close_room');

  // 恢复后的连接可以正常关房
  mod2.send({ op: 'close_room' });
  assert.equal((await node.next()).op, 'close_room');
  assert.equal((await mod2.next()).op, 'room_closed');
});

test('resume：token 无效返回 resume_failed', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const mod = await helloMod(ctl, { resume: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  assert.equal((await mod.next()).op, 'hello_ok');
  const err = await mod.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'resume_failed');
});

test('节点心跳超时：摘除节点并销毁其上房间（定时器注入缩短）', async (t) => {
  const ctl = await startControl({ heartbeatTimeoutMs: 200, sweepMs: 50 });
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl);
  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');
  const { openReq } = await createRoom(mod, node);

  // 节点停止心跳（连接保持），等待 sweep 摘除
  const closed = await mod.next(2000);
  assert.equal(closed.op, 'room_closed');
  assert.equal(closed.reason, 'node_down');
  assert.equal(ctl.registry.get(openReq.code), undefined);
  assert.equal(ctl.nodeGateway.onlineNodes().length, 0, '超时节点应被摘除');
});

// ============ M2: direct_candidates 数组 ============

test('create_room：direct_candidates 数组被接受并按 addr:port 去重', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl, 'tok-1', { name: '节点', addr: '1.1.1.1', tunnel_port: 20000 });
  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');

  const { roomOk } = await createRoom(mod, node, 23456, {
    direct: { mode: 'upnp', addr: '8.8.8.8', tcp_port: 6567, udp_port: 6567 },
    direct_candidates: [
      { mode: 'upnp', addr: '8.8.8.8', tcp_port: 6567, udp_port: 6567 },   // 与 direct 重复
      { mode: 'stun', addr: '8.8.8.8', tcp_port: 6567, udp_port: 6567 },   // 与上面重复
      { mode: 'stun', addr: '9.9.9.9', tcp_port: 6567, udp_port: 6567 },   // 新地址
      { mode: 'manual', addr: '7.7.7.7', tcp_port: 12345, udp_port: 12345 },
      { mode: 'upnp', addr: '8.8.4.4', tcp_port: 6567, udp_port: 6568 }    // 合法 stun（非 upnp 可不同端口）
    ]
  });

  const res = await fetchJson(ctl.port, `/api/rooms/${roomOk.code}`);
  assert.equal(res.statusCode, 200);
  // direct 保留旧格式
  assert.deepEqual(res.body.direct, { mode: 'upnp', addr: '8.8.8.8', port: 6567 });
  // direct_candidates 应该去重后保留 3 个：8.8.8.8:6567, 9.9.9.9:6567, 7.7.7.7:12345
  // 8.8.4.4 tcp:6567 udp:6568 是非法 upnp（但 mode 是 upnp），应被丢弃
  assert.ok(Array.isArray(res.body.direct_candidates));
  assert.equal(res.body.direct_candidates.length, 3);
  const addrs = res.body.direct_candidates.map(c => `${c.addr}:${c.port}`).sort();
  assert.deepEqual(addrs, ['7.7.7.7:12345', '8.8.8.8:6567', '9.9.9.9:6567']);
});

test('create_room：非法 mode 在 direct_candidates 中被静默过滤', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl);
  const mod = await helloMod(ctl);
  assert.equal((await mod.next()).op, 'hello_ok');

  const { roomOk } = await createRoom(mod, node, 23456, {
    direct_candidates: [
      { mode: 'holepunch', addr: '1.2.3.4', tcp_port: 1000, udp_port: 1000 }, // 非法 mode
      { mode: 'upnp', addr: '1.2.3.4', tcp_port: 1000, udp_port: 1000 },     // 合法
      { mode: 'stun', addr: '', tcp_port: 1000, udp_port: 1000 },             // 空 addr
      { mode: 'manual', addr: '1.2.3.4', tcp_port: 0, udp_port: 0 }           // 端口越界
    ]
  });

  const res = await fetchJson(ctl.port, `/api/rooms/${roomOk.code}`);
  assert.equal(res.body.direct_candidates.length, 1);
  assert.equal(res.body.direct_candidates[0].mode, 'upnp');
});

// ============ M2: 社区节点 ============

test('社区节点 token：注册后返回 official=false', async (t) => {
  const tokenMap = new Map();
  tokenMap.set('official-tok', {
    token: 'official-tok', id: 'node-1', name: '官方节点',
    owner: '', official: true, region: '华东', tags: [], description: '', createdAt: 0
  });
  tokenMap.set('community-tok', {
    token: 'community-tok', id: 'lln-abc', name: '社区节点',
    owner: 'alice', official: false, region: '华北', tags: ['community'], description: '测试', createdAt: 0
  });

  const ctl = await startControl({ tokenMap });
  t.after(() => ctl.close());

  await registerNode(ctl, 'official-tok', { name: '官方', addr: '1.1.1.1', tunnel_port: 20000 });
  await registerNode(ctl, 'community-tok', { name: '社区', addr: '2.2.2.2', tunnel_port: 21000 });

  const res = await fetchJson(ctl.port, '/api/nodes/available');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.nodes.length, 2);

  const official = res.body.nodes.find(n => n.id === 'node-1');
  const community = res.body.nodes.find(n => n.id === 'lln-abc');
  assert.equal(official.official, true);
  assert.equal(official.owner, '');
  assert.equal(community.official, false);
  assert.equal(community.owner, 'alice');
  assert.equal(community.region, '华北');
  assert.equal(community.description, '测试');
});

test('节点注册：无效 token 被拒绝', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const node = await wsClient(`ws://127.0.0.1:${ctl.port}/ws/node`);
  await node.ready;
  node.send({ op: 'register', ver: 2, token: 'bad-token', name: 'evil', addr: '9.9.9.9', tunnel_port: 20000, port_range: [20001, 20099] });
  const err = await node.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'auth_failed');
});

// ============ M2: admin token CRUD ============

test('admin token CRUD：创建 / 列表 / 撤销', async (t) => {
  const forumClient = { async verifyForumSession() { return { id: 1, username: 'admin', role: 'admin' }; } };
  const ctl = await startControl({ forumClient });
  t.after(() => ctl.close());

  // 列出（初始只有官方 token）
  const list1 = await fetchJson(ctl.port, '/api/admin/nodes/tokens', { 'x-forum-session': 'admin-session' });
  assert.equal(list1.statusCode, 200);
  assert.equal(list1.body.tokens.length, 1);
  assert.equal(list1.body.tokens[0].official, true);

  // 创建社区 token
  const created = await postJson(ctl.port, '/api/admin/nodes/tokens',
    { name: '测试社区', owner: 'bob', region: '华南', description: '测试节点' },
    'admin-session');
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.ok, true);
  assert.ok(created.body.token.token.startsWith(''));  // token 是 hex
  assert.equal(created.body.token.official, false);
  assert.equal(created.body.token.owner, 'bob');
  const newId = created.body.token.id;
  const newToken = created.body.token.token;

  // 列出（应有 2 个）
  const list2 = await fetchJson(ctl.port, '/api/admin/nodes/tokens', { 'x-forum-session': 'admin-session' });
  assert.equal(list2.body.tokens.length, 2);

  // 用新 token 注册节点
  const { id: registeredId } = await registerNode(ctl, newToken, { name: '新社区节点', addr: '3.3.3.3', tunnel_port: 22000 });
  assert.equal(registeredId, newId);

  // 撤销
  const revoked = await deleteJson(ctl.port, `/api/admin/nodes/tokens/${newId}`, 'admin-session');
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.body.ok, true);

  // 撤销后再用同 token 注册应失败
  const node2 = await wsClient(`ws://127.0.0.1:${ctl.port}/ws/node`);
  await node2.ready;
  node2.send({ op: 'register', ver: 2, token: newToken, name: 'evil', addr: '9.9.9.9', tunnel_port: 23000, port_range: [23001, 23099] });
  const err = await node2.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'auth_failed');
});

test('admin token：撤销官方 token 应被拒绝', async (t) => {
  const forumClient = { async verifyForumSession() { return { id: 1, username: 'admin', role: 'admin' }; } };
  const ctl = await startControl({ forumClient });
  t.after(() => ctl.close());

  const res = await deleteJson(ctl.port, '/api/admin/nodes/tokens/node-1', 'admin-session');
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'forbidden');
});

// ============ Mod 版本校验 ============

// ============ M2: /ws/guest ============

test('/ws/guest：hello + join_request + join_accepted 流程', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const ctl = await startControl({ tokenService });
  t.after(() => ctl.close());

  // 房主开房
  const { node } = await registerNode(ctl, 'tok-1', { name: '节点', addr: '1.1.1.1', tunnel_port: 20000 });
  const host = await helloMod(ctl);
  assert.equal((await host.next()).op, 'hello_ok');
  const { roomOk } = await createRoom(host, node, 23456, {
    direct_candidates: [{ mode: 'upnp', addr: '8.8.8.8', tcp_port: 6567, udp_port: 6567 }]
  });

  // 客人连 /ws/guest（已登录）
  const guestToken = tokenService.issue({ id: 99, username: 'bob', role: 'user', phone_verified: true });
  const guest = await wsClient(`ws://127.0.0.1:${ctl.port}/ws/guest`);
  await guest.ready;
  guest.send({ op: 'hello', ver: 2, build: 146, platform: 'desktop', mod_version: '0.1.0', token: guestToken });
  assert.equal((await guest.next()).op, 'hello_ok');

  // 客人加入房间
  guest.send({
    op: 'join_request',
    code: roomOk.code,
    candidates: [{ mode: 'stun', addr: '9.9.9.9', udp_port: 54321 }]
  });
  const accepted = await guest.next();
  assert.equal(accepted.op, 'join_accepted');
  assert.ok(accepted.peer_id);
  assert.equal(accepted.room.code, roomOk.code);
  assert.ok(Array.isArray(accepted.host_candidates));
  assert.equal(accepted.host_candidates.length, 1);
  assert.equal(accepted.host_candidates[0].addr, '8.8.8.8');

  // 房主应收到 peer_joined
  const peerJoined = await host.next();
  assert.equal(peerJoined.op, 'peer_join');
  assert.ok(peerJoined.peer_id);
  assert.ok(Array.isArray(peerJoined.peer_candidates));
  assert.equal(peerJoined.peer_candidates.length, 1);
  assert.equal(peerJoined.peer_candidates[0].addr, '9.9.9.9');
});

test('/ws/guest：房间不存在返回 room_not_found', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const ctl = await startControl({ tokenService });
  t.after(() => ctl.close());

  const guestToken = tokenService.issue({ id: 99, username: 'bob', role: 'user', phone_verified: true });
  const guest = await wsClient(`ws://127.0.0.1:${ctl.port}/ws/guest`);
  await guest.ready;
  guest.send({ op: 'hello', ver: 2, build: 146, platform: 'desktop', token: guestToken });
  await guest.next();  // hello_ok

  guest.send({ op: 'join_request', code: 'MDT-NOT999' });
  const err = await guest.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'room_not_found');
});

test('/ws/guest：未登录客人加入房间返回 login_required', async (t) => {
  const ctl = await startControl();
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl, 'tok-1', { name: '节点', addr: '1.1.1.1', tunnel_port: 20000 });
  const host = await helloMod(ctl);
  await host.next(); // hello_ok
  const { roomOk } = await createRoom(host, node, 23456);

  const guest = await wsClient(`ws://127.0.0.1:${ctl.port}/ws/guest`);
  await guest.ready;
  guest.send({ op: 'hello', ver: 2, build: 146, platform: 'desktop' });
  await guest.next(); // hello_ok

  guest.send({ op: 'join_request', code: roomOk.code });
  const err = await guest.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'login_required');
});

test('/ws/mod：未验证手机号无法创建房间', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const ctl = await startControl({ tokenService });
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl, 'tok-1', { name: '节点', addr: '1.1.1.1', tunnel_port: 20000 });

  // 未验证手机号的用户
  const token = tokenService.issue({ id: 42, username: 'unverified', role: 'user', phone_verified: false });
  const mod = await helloMod(ctl, { token });
  await mod.next(); // hello_ok

  mod.send({ op: 'create_room', name: '测试房间', public: false, vanilla_join: true, game_port: 6567 });
  const err = await mod.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'phone_verification_required');
  assert.ok(err.verify_url !== undefined);
});

test('/ws/guest：未验证手机号无法加入房间', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const ctl = await startControl({ tokenService });
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl, 'tok-1', { name: '节点', addr: '1.1.1.1', tunnel_port: 20000 });
  const host = await helloMod(ctl);
  await host.next(); // hello_ok
  const { roomOk } = await createRoom(host, node, 23456);

  // 未验证手机号的客人
  const guestToken = tokenService.issue({ id: 99, username: 'guest_unverified', role: 'user', phone_verified: false });
  const guest = await wsClient(`ws://127.0.0.1:${ctl.port}/ws/guest`);
  await guest.ready;
  guest.send({ op: 'hello', ver: 2, build: 146, platform: 'desktop', token: guestToken });
  await guest.next(); // hello_ok

  guest.send({ op: 'join_request', code: roomOk.code });
  const err = await guest.next();
  assert.equal(err.op, 'error');
  assert.equal(err.code, 'phone_verification_required');
  assert.ok(err.verify_url !== undefined);
});

test('/ws/mod 和 /ws/guest：已验证手机号可以正常操作', async (t) => {
  const tokenService = createTokenService({ secret: 'test-lanlink-secret', ttlSeconds: 60 });
  const ctl = await startControl({ tokenService });
  t.after(() => ctl.close());

  const { node } = await registerNode(ctl, 'tok-1', { name: '节点', addr: '1.1.1.1', tunnel_port: 20000 });

  // 已验证手机号的房主
  const hostToken = tokenService.issue({ id: 42, username: 'verified_host', role: 'user', phone_verified: true });
  const host = await helloMod(ctl, { token: hostToken });
  await host.next(); // hello_ok
  const { roomOk } = await createRoom(host, node, 23456);
  assert.equal(roomOk.code.startsWith('MDT-'), true);

  // 已验证手机号的客人
  const guestToken = tokenService.issue({ id: 99, username: 'verified_guest', role: 'user', phone_verified: true });
  const guest = await wsClient(`ws://127.0.0.1:${ctl.port}/ws/guest`);
  await guest.ready;
  guest.send({ op: 'hello', ver: 2, build: 146, platform: 'desktop', token: guestToken });
  await guest.next(); // hello_ok

  guest.send({ op: 'join_request', code: roomOk.code });
  const accepted = await guest.next();
  assert.equal(accepted.op, 'join_accepted');
  assert.ok(accepted.peer_id);
});
