'use strict';

require('dotenv').config();

const http = require('http');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const { WebSocketServer } = require('ws');

const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');
const healthRoute = require('./routes/health');
const nodesRoute = require('./routes/nodes');
const roomsRoute = require('./routes/rooms');
const authRoute = require('./routes/auth');
const adminRoute = require('./routes/admin');
const db = require('./db');
const { createRoomRegistry } = require('./control/roomRegistry');
const { createNodeGateway } = require('./control/nodeSocket');
const { createModGateway } = require('./control/modSocket');
const { createGuestGateway } = require('./control/guestSocket');
const { createForumClient } = require('./auth/forumClient');
const { createTokenService } = require('./auth/tokenService');
const { createPresenceService } = require('./control/presence');
const friendsRoute = require('./routes/friends');
const nodePicker = require('./control/nodePicker');
const { createConnectionMonitor } = require('./control/connectionMonitor');

const { createClientIpMiddleware } = require('./middleware/clientIp');

const app = new Koa();

// 客户端 IP 解析：按优先级依次读取 ali-real-client-ip → x-real-ip → cf-connecting-ip → x-forwarded-for[0]，
// 任一头缺失或无效则继续向下；全部无效时回退到 socket peer IP。控制面部署选择无条件采信这些头。
app.proxy = false;
app.use(createClientIpMiddleware());

// Security headers - prevent information leakage and common attacks
app.use(async (ctx, next) => {
  ctx.set('X-Content-Type-Options', 'nosniff');
  ctx.set('X-Frame-Options', 'DENY');
  ctx.set('X-XSS-Protection', '1; mode=block');
  ctx.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  ctx.remove('X-Powered-By');
  await next();
});

// 错误处理
app.use(errorHandler);

// CORS - 从环境变量读取允许的 origins（不引入额外依赖，手写等价逻辑）。
// 生产环境必须显式配置，避免带着开发用的信任列表上线。
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ALLOWED_ORIGINS) {
  throw new Error('CORS_ALLOWED_ORIGINS 必须在生产环境中配置');
}

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(async (ctx, next) => {
  const requestOrigin = ctx.request.header.origin;
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    ctx.set('Access-Control-Allow-Origin', requestOrigin);
    ctx.set('Vary', 'Origin');
    ctx.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
    ctx.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (ctx.method === 'OPTIONS') {
    ctx.status = 204;
    return;
  }
  await next();
});

// 请求体解析
app.use(bodyParser({
  json: { limit: '1mb' }
}));

// 路由
app.use(routes.routes());
app.use(routes.allowedMethods());

// 404 处理
app.use((ctx) => {
  ctx.status = 404;
  ctx.body = { success: false, message: 'Not found' };
});

// 启动服务
async function start() {
  // 初始化数据库（迁移）
  await db.initDatabase();

  const server = http.createServer(app.callback());

  const tokenService = createTokenService({
    secret: config.auth.tokenSecret,
    ttlSeconds: config.auth.tokenTtlSeconds
  });
  const forumClient = createForumClient({
    baseUrl: config.forum.baseUrl,
    apiKey: config.forum.externalApiKey,
    quickCodePath: config.forum.quickCodePath,
    verifyPath: config.forum.verifyPath
  });
  if (forumClient.devMode) {
    console.log('⚠  FORUM_BASE_URL 未配置 → 登录走 dev 模式（任意识别码 → dev-<用户名>，admin 自动放行）');
  }
  authRoute.setAuthServices({ forumClient, tokenService, config });
  adminRoute.setAdminServices({ forumClient, registry: null, nodeGateway: null });

  // MindFourm 好友/邀请路由装配（presenceService 和 friends 在 registry 创建后装配）

  // 同一 HTTP 端口上的三个 WS 升级路径
  const modWss = new WebSocketServer({ noServer: true });
  const nodeWss = new WebSocketServer({ noServer: true });
  const guestWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
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

  // 构建统一 token registry：官方 token + 社区 token
  const tokenMap = new Map();
  for (let i = 0; i < config.nodeTokens.length; i++) {
    const t = config.nodeTokens[i];
    tokenMap.set(t, {
      token: t,
      id: `node-${i + 1}`,
      name: `节点 ${i + 1}`,
      owner: '',
      official: true,
      region: '',
      tags: [],
      description: '',
      createdAt: 0
    });
  }
  for (const entry of config.communityNodeTokens.tokens) {
    if (!entry.token || tokenMap.has(entry.token)) continue;
    // 社区 token 必须有显式 id；若无则自动生成
    const id = entry.id || `lln-${require('crypto').randomBytes(4).toString('hex')}`;
    tokenMap.set(entry.token, { ...entry, id });
  }

  // 控制面装配：房间注册表 + 节点网关 + Mod 网关
  const registry = createRoomRegistry({
    graceMs: config.room.graceMs,
    persistence: {
      saveRoom: db.redis.saveRoom,
      deleteRoom: db.redis.deleteRoom,
      writeHistory: db.mysql.insertRoomHistory
    }
  });

  const nodeGateway = createNodeGateway({
    wss: nodeWss,
    tokens: config.nodeTokens,
    tokenMap,
    registry,
    heartbeatTimeoutMs: config.node.heartbeatTimeoutMs,
    sweepMs: config.node.sweepMs,
    openTimeoutMs: config.node.openTimeoutMs,
    persistence: {
      saveNode: db.redis.saveNode,
      refreshNode: db.redis.refreshNode,
      deleteNode: db.redis.deleteNode,
      writeBandwidth: db.mysql.insertBandwidthLogs
    }
  });

  // 客人 WS 网关（/ws/guest）
  const guestGateway = createGuestGateway({
    wss: guestWss,
    registry,
    tokenService,
    settings: {
      serverVersion: config.serverVersion,
      motd: config.motd,
      latest: config.version.latest,
      protocolVersion: config.protocolVersion,
      downloadUrl: config.version.url,
      verificationPageUrl: config.forum.verificationPageUrl
    }
  });

  // 房间销毁时通知客人网关清理连接
  const originalOnDestroy = registry.onDestroy;
  registry.onDestroy = (room, reason) => {
    if (guestGateway && typeof guestGateway.onRoomDestroyed === 'function') {
      guestGateway.onRoomDestroyed(room);
    }
    if (typeof originalOnDestroy === 'function') originalOnDestroy(room, reason);
  };

  adminRoute.setAdminServices({ forumClient, registry, nodeGateway });

  // MindFourm 好友/邀请路由装配（registry 已就绪）
  const presenceService = createPresenceService({ redis: db.redis.redis, config });
  friendsRoute.setFriendsServices({ forumClient, tokenService, presenceService, registry });

  createModGateway({
    wss: modWss,
    registry,
    nodeGateway,
    picker: nodePicker,
    tokenService,
    accessConfig: config.node.access,
    presenceService,
    settings: {
      protocolVersion: config.protocolVersion,
      motd: config.motd,
      latest: config.version.latest,
      serverVersion: config.serverVersion,
      downloadUrl: config.version.url,
      allowedModVersions: config.allowedModVersions,
      verificationPageUrl: config.forum.verificationPageUrl
    }
  });

  healthRoute.setNodeCounter(() => nodeGateway.onlineNodes().length);
  nodesRoute.setNodeLister(() => nodeGateway.onlineNodes());
  nodesRoute.setNodeAccessServices({ tokenService, accessConfig: config.node.access });
  roomsRoute.setRoomLookup((code) => registry.get(code));
  roomsRoute.setRoomLister(() => registry.all());

  server.listen(config.port, () => {
    console.log(`LanLink control plane running at http://localhost:${config.port}`);
    console.log(`WS endpoints: ws://localhost:${config.port}/ws/mod , /ws/node , /ws/guest`);
  });

  // 连接监控（每 60 秒检查一次）
  const monitor = createConnectionMonitor({
    modWss,
    nodeWss,
    guestWss,
    registry,
    nodeGateway,
    guestGateway,
    intervalMs: 60000
  });
  monitor.start();

  // 优雅关闭
  let shuttingDown = false;

  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Received ${signal}, shutting down...`);

    // 0. 停止监控
    monitor.stop();

    // 1. 停止接受新连接，并等待在途请求完成（兜底 10s）
    await new Promise((resolve) => {
      server.close(() => {
        console.log('HTTP server closed');
        resolve();
      });
      setTimeout(resolve, 10000).unref();
    });

    // 2. 关闭所有 WS 连接与后台定时器
    for (const ws of modWss.clients) ws.terminate();
    for (const ws of nodeWss.clients) ws.terminate();
    for (const ws of guestWss.clients) ws.terminate();  // 修复：关闭 guest 连接
    nodeGateway.close();

    // 3. 关闭数据库连接
    await db.close();

    console.log('Graceful shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    gracefulShutdown('uncaughtException').catch(() => process.exit(1));
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});

module.exports = app;
