'use strict';

/**
 * 隧道端到端测试：fake-game-server（TCP echo + UDP echo，UDP 回包携带
 * 「收到的源端口」）+ 进程内节点数据面（createRelay）+ fake-host（Mod 侧协议
 * 参考实现）+ 两个 fake-guest（TCP + UDP）。
 *
 * 断言：
 *  (a) TCP 双向字节透传正确
 *  (b) 两个 guest 的 UDP 到达 fake-game-server 时源端口不同（防串包铁律）
 *  (c) guest UDP 回程正确送达各自 socket
 *  (d) 会话过期通知（[LLKU][0x02][sid]）
 *
 * 不依赖真实游戏与数据库。
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { once } = require('events');

const { createRelay } = require('../src/node/agent');
const { FakeHost } = require('./helpers/fakeHost');

const quietLog = { log() {}, warn() {}, error() {} };

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await delay(stepMs);
  }
  throw new Error('waitFor timeout');
}

function getFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 找一个 TCP + UDP 同号均可绑定的空闲端口 */
async function getFreePortPair() {
  for (let i = 0; i < 20; i++) {
    const p = await getFreeTcpPort();
    const udpOk = await new Promise((resolve) => {
      const u = dgram.createSocket('udp4');
      u.once('error', () => resolve(false));
      u.bind(p, '127.0.0.1', () => u.close(() => resolve(true)));
    });
    if (udpOk) return p;
  }
  throw new Error('找不到 TCP+UDP 同号空闲端口');
}

/**
 * fake-game-server：TCP echo + UDP echo（同一端口号）。
 * UDP 回包格式 `${收到的源端口}|` + 原 payload —— 供防串包断言。
 */
async function startFakeGameServer() {
  for (let i = 0; i < 20; i++) {
    const tcp = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.pipe(sock);
    });
    const port = await new Promise((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen(0, '127.0.0.1', () => resolve(tcp.address().port));
    });
    const udp = dgram.createSocket('udp4');
    const bound = await new Promise((resolve) => {
      udp.once('error', () => resolve(false));
      udp.bind(port, '127.0.0.1', () => resolve(true));
    });
    if (!bound) {
      tcp.close();
      try { udp.close(); } catch { /* ignore */ }
      continue;
    }
    udp.on('message', (msg, rinfo) => {
      const reply = Buffer.concat([Buffer.from(`${rinfo.port}|`), msg]);
      udp.send(reply, rinfo.port, rinfo.address);
    });
    return {
      port,
      close() {
        tcp.close();
        try { udp.close(); } catch { /* ignore */ }
      }
    };
  }
  throw new Error('fake-game-server 启动失败');
}

function readExactly(sock, len, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let got = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('TCP read timeout'));
    }, timeoutMs);
    const onData = (c) => {
      chunks.push(c);
      got += c.length;
      if (got >= len) {
        cleanup();
        resolve(Buffer.concat(chunks).subarray(0, len));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
    };
    sock.on('data', onData);
  });
}

function onceMessage(sock, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('UDP reply timeout')), timeoutMs);
    sock.once('message', (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

function bindUdp() {
  const sock = dgram.createSocket('udp4');
  sock.on('error', () => {});
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve(sock)));
}

/** 解析 fake-game-server 的 UDP 回包：`${源端口}|payload` */
function parseGameReply(buf) {
  const s = buf.toString('utf8');
  const i = s.indexOf('|');
  return { srcPort: Number(s.slice(0, i)), payload: s.slice(i + 1) };
}

test('隧道端到端：TCP 透传 / UDP 防串包 / 回程各归各家 / 会话过期', async (t) => {
  const game = await startFakeGameServer();
  t.after(() => game.close());

  const tunnelPort = await getFreePortPair();
  const relay = await createRelay({
    tunnelPort,
    portRanges: [{ min: 31500, max: 31580 }],
    bindHost: '127.0.0.1',
    udpSessionTtlMs: 500, // 注入缩短：真实值 2 分钟
    udpSweepMs: 100,
    log: quietLog
  });
  t.after(() => relay.close());

  const roomToken = crypto.randomBytes(16).toString('hex');
  const { roomPort } = await relay.openRoom({ code: 'MDT-TEST22', roomToken });
  assert.ok(roomPort >= 31500 && roomPort <= 31580, '房间端口应在 PORT_RANGE 内');

  const host = new FakeHost({ tunnelPort, roomToken, gamePort: game.port });
  const closedSessions = [];
  host.on('session_closed', (sid) => closedSessions.push(sid));
  await host.start();
  t.after(() => host.close());

  // 等待控制链与 UDP 注册在节点侧生效
  const room = relay.rooms.get('MDT-TEST22');
  await waitFor(() => room.control != null && room.modUdp != null);

  // ---- (a) TCP 双向字节透传 ----
  const guest1 = net.connect(roomPort, '127.0.0.1');
  guest1.on('error', () => {});
  await once(guest1, 'connect');
  guest1.write('hello-through-tunnel');
  const echo1 = await readExactly(guest1, 'hello-through-tunnel'.length);
  assert.equal(echo1.toString(), 'hello-through-tunnel', 'TCP echo 应原样透传');

  // 第二轮，确认 splice 后持续双向可用
  guest1.write('roundtrip-2');
  const echo2 = await readExactly(guest1, 'roundtrip-2'.length);
  assert.equal(echo2.toString(), 'roundtrip-2');

  // ---- (b)(c) 两个 guest 的 UDP ----
  const udpGuestA = await bindUdp();
  const udpGuestB = await bindUdp();
  t.after(() => { try { udpGuestA.close(); } catch { /* */ } });
  t.after(() => { try { udpGuestB.close(); } catch { /* */ } });

  const replyA = onceMessage(udpGuestA);
  const replyB = onceMessage(udpGuestB);
  udpGuestA.send(Buffer.from('ping-A'), roomPort, '127.0.0.1');
  udpGuestB.send(Buffer.from('ping-B'), roomPort, '127.0.0.1');
  const [rawA, rawB] = await Promise.all([replyA, replyB]);
  const a = parseGameReply(rawA);
  const b = parseGameReply(rawB);

  // (c) 回程正确送达各自 socket
  assert.equal(a.payload, 'ping-A', 'guest A 应收到自己的 payload');
  assert.equal(b.payload, 'ping-B', 'guest B 应收到自己的 payload');

  // (b) 防串包铁律：两个 guest 到达游戏服务器时的源端口必须不同
  assert.ok(Number.isInteger(a.srcPort) && Number.isInteger(b.srcPort));
  assert.notEqual(a.srcPort, b.srcPort, '两个 guest 到达游戏服务器的 UDP 源端口必须不同');

  // 节点侧应有两个独立 UDP 会话
  assert.equal(room.udpById.size, 2, '节点侧应为两个客人分配两个 sessionId');

  // ---- (d) 会话过期通知 ----
  await waitFor(() => closedSessions.length >= 2, 5000);
  assert.equal(closedSessions.length, 2, '两个会话过期都应通知 Mod');
  assert.equal(room.udpById.size, 0, '过期会话应从节点侧回收');

  // ---- conn_closed 通知 ----
  const connClosed = new Promise((resolve) => host.once('conn_closed', resolve));
  guest1.destroy();
  const closedId = await Promise.race([
    connClosed,
    delay(3000).then(() => { throw new Error('conn_closed timeout'); })
  ]);
  assert.equal(typeof closedId, 'number');
});

test('隧道握手：roomToken 校验失败立即断开', async (t) => {
  const tunnelPort = await getFreePortPair();
  const relay = await createRelay({
    tunnelPort,
    portRanges: [{ min: 31600, max: 31620 }],
    bindHost: '127.0.0.1',
    log: quietLog
  });
  t.after(() => relay.close());

  await relay.openRoom({ code: 'MDT-TEST33', roomToken: crypto.randomBytes(16).toString('hex') });

  const bad = net.connect(tunnelPort, '127.0.0.1');
  bad.on('error', () => {});
  await once(bad, 'connect');
  // 错误 token 的控制链握手
  const buf = Buffer.alloc(25);
  Buffer.from('LLK1').copy(buf, 0);
  buf[4] = 0x01;
  crypto.randomBytes(16).copy(buf, 5);
  buf.writeUInt32BE(0, 21);
  bad.write(buf);
  await once(bad, 'close');
  assert.ok(bad.destroyed, '错误 roomToken 应被立即断开');
});

test('端口池：房间关闭后端口回收可复用', async (t) => {
  const tunnelPort = await getFreePortPair();
  const relay = await createRelay({
    tunnelPort,
    portRanges: [{ min: 31700, max: 31701 }], // 只有两个端口
    bindHost: '127.0.0.1',
    log: quietLog
  });
  t.after(() => relay.close());

  const r1 = await relay.openRoom({ code: 'MDT-AAAAAA', roomToken: crypto.randomBytes(16).toString('hex') });
  const r2 = await relay.openRoom({ code: 'MDT-BBBBBB', roomToken: crypto.randomBytes(16).toString('hex') });
  assert.notEqual(r1.roomPort, r2.roomPort);

  // 幂等：重复 open 回报既有端口
  const r1again = await relay.openRoom({ code: 'MDT-AAAAAA', roomToken: 'ignored-for-idempotent' });
  assert.equal(r1again.roomPort, r1.roomPort);

  // 池已满
  await assert.rejects(
    () => relay.openRoom({ code: 'MDT-CCCCCC', roomToken: crypto.randomBytes(16).toString('hex') }),
    /端口池耗尽/
  );

  // 关闭一间即可复用
  relay.closeRoom('MDT-AAAAAA');
  const r3 = await relay.openRoom({ code: 'MDT-DDDDDD', roomToken: crypto.randomBytes(16).toString('hex') });
  assert.equal(r3.roomPort, r1.roomPort, '回收的端口应被复用');
});
