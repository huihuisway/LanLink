'use strict';

const crypto = require('crypto');
const Router = require('@koa/router');
const { sanitizeLabelPart } = require('../control/displayName');

const router = new Router();
let registry = null;
let nodeGateway = null;
let forumClient = null;
let tokenGenerator = null;  // 由 app.js 注入：() => string
const audit = [];

function setAdminServices(services = {}) {
  registry = services.registry || null;
  nodeGateway = services.nodeGateway || null;
  forumClient = services.forumClient || null;
  tokenGenerator = services.tokenGenerator || (() => crypto.randomBytes(16).toString('hex'));
}

function sessionToken(ctx) {
  const header = ctx.get('x-forum-session');
  if (header) return header;
  const cookie = ctx.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)forum_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function adminUser(ctx) {
  // dev 模式：无论坛，自动放行 dev admin（不要求 cookie）
  if (forumClient && forumClient.devMode) {
    return { id: 'dev-admin', username: 'dev-admin', role: 'super_admin', roles: ['admin', 'super_admin'] };
  }
  if (!forumClient) return null;
  const token = sessionToken(ctx);
  if (!token) return null;
  const user = await forumClient.verifyForumSession(token);
  if (!user || !['admin', 'super_admin'].includes(user.role)) return null;
  return user;
}

async function requireAdmin(ctx) {
  const user = await adminUser(ctx);
  if (!user) {
    ctx.status = 403;
    ctx.body = { ok: false, code: 'admin_forbidden', message: '需要论坛管理员身份' };
    return null;
  }
  return user;
}

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name || '',
    display_name: room.displayName || '',
    public: !!room.isPublic,
    hidden: !!room.hidden,
    hidden_reason: room.hiddenReason || '',
    owner: room.owner || { type: 'anonymous', display_name: '匿名房主' },
    node: { id: room.nodeId, name: room.nodeName || room.nodeId, addr: room.nodeAddr, room_port: room.roomPort },
    created_at: room.createdAt || 0,
    owner_connected: !!room.ownerConnected
  };
}

function record(user, action, targetType, targetId, reason, ctx) {
  audit.unshift({
    admin_user_id: user.id,
    admin_name: user.username,
    action,
    target_type: targetType,
    target_id: targetId,
    reason: reason || '',
    ip: ctx.ip,
    created_at: Date.now()
  });
  if (audit.length > 200) audit.length = 200;
}

router.get('/', async (ctx) => {
  const user = await adminUser(ctx);
  ctx.type = 'html';
  ctx.body = `<!doctype html><meta charset="utf-8"><title>LanLink Admin</title>
<style>body{font-family:sans-serif;margin:24px;max-width:960px}code{background:#eee;padding:2px 4px}button{margin-left:8px}</style>
<h1>LanLink 控制面</h1>
<p>${user ? `当前管理员：<b>${user.username}</b>` : '未检测到论坛管理员会话。请从论坛管理员账号进入，或调试时携带 <code>x-forum-session</code>。'}</p>
<p>管理 API：<code>/api/admin/rooms</code>、<code>/api/admin/nodes</code>、<code>/api/admin/audit</code></p>`;
});

router.get('/rooms', async (ctx) => {
  const user = await requireAdmin(ctx);
  if (!user) return;
  ctx.body = { ok: true, rooms: registry ? registry.all().map(publicRoom) : [] };
});

router.post('/rooms/:code/close', async (ctx) => {
  const user = await requireAdmin(ctx);
  if (!user) return;
  const code = String(ctx.params.code || '').toUpperCase();
  const room = registry && registry.get(code);
  if (!room) {
    ctx.status = 404;
    ctx.body = { ok: false, code: 'not_found', message: '房间不存在' };
    return;
  }
  const reason = (ctx.request.body && ctx.request.body.reason) || 'admin_closed';
  registry.destroyRoom(code, 'kicked');
  record(user, 'room.close', 'room', code, reason, ctx);
  ctx.body = { ok: true };
});

router.post('/rooms/:code/hide', async (ctx) => {
  const user = await requireAdmin(ctx);
  if (!user) return;
  const code = String(ctx.params.code || '').toUpperCase();
  const reason = (ctx.request.body && ctx.request.body.reason) || 'admin_hidden';
  const room = registry && registry.hideRoom(code, reason);
  if (!room) {
    ctx.status = 404;
    ctx.body = { ok: false, code: 'not_found', message: '房间不存在' };
    return;
  }
  record(user, 'room.hide', 'room', code, reason, ctx);
  ctx.body = { ok: true, room: publicRoom(room) };
});

router.get('/nodes', async (ctx) => {
  const user = await requireAdmin(ctx);
  if (!user) return;
  ctx.body = { ok: true, nodes: nodeGateway ? nodeGateway.onlineNodes().map((node) => ({
    id: node.id,
    name: node.name,
    addr: node.addr,
    tunnel_port: node.tunnelPort,
    rooms: node.stats.rooms,
    sessions: node.stats.sessions,
    mbps_used: node.stats.mbpsUsed,
    connected: node.connected,
    last_seen: node.lastSeen,
    // M2 社区节点字段
    official: node.official !== false,
    owner: node.owner || '',
    region: node.region || '',
    description: node.description || ''
  })) : [] };
});

// Token 管理：列出所有节点 token（脱敏）
router.get('/nodes/tokens', async (ctx) => {
  const user = await requireAdmin(ctx);
  if (!user) return;
  if (!nodeGateway || typeof nodeGateway.allTokenInfos !== 'function') {
    ctx.body = { ok: true, tokens: [] };
    return;
  }
  ctx.body = { ok: true, tokens: nodeGateway.allTokenInfos() };
});

// 创建新社区节点 token
router.post('/nodes/tokens', async (ctx) => {
  const user = await requireAdmin(ctx);
  if (!user) return;
  if (!nodeGateway || typeof nodeGateway.addToken !== 'function') {
    ctx.status = 503;
    ctx.body = { ok: false, code: 'not_supported', message: '当前控制面不支持动态 token' };
    return;
  }
  const body = ctx.request.body || {};
  const token = tokenGenerator();
  const id = 'lln-' + crypto.randomBytes(4).toString('hex');
  const info = {
    token,
    id,
    name: sanitizeLabelPart(body.name, id, 32),
    owner: sanitizeLabelPart(body.owner, '', 64),
    official: false,
    region: sanitizeLabelPart(body.region, '', 16),
    tags: ['community'],
    description: sanitizeLabelPart(body.description, '', 200),
    createdAt: Date.now()
  };
  if (!nodeGateway.addToken(info)) {
    ctx.status = 409;
    ctx.body = { ok: false, code: 'conflict', message: 'token 冲突，请重试' };
    return;
  }
  record(user, 'token.create', 'token', id, '', ctx);
  ctx.body = {
    ok: true,
    token: info,
    registration: {
      node_token: token,
      node_id: id,
      node_name: info.name,
      instructions: '将 node_token 配置到 agent.js 的 NODE_TOKEN 环境变量后启动节点进程'
    }
  };
});

// 撤销 token
router.delete('/nodes/tokens/:id', async (ctx) => {
  const user = await requireAdmin(ctx);
  if (!user) return;
  if (!nodeGateway || typeof nodeGateway.getTokenInfoById !== 'function') {
    ctx.status = 503;
    ctx.body = { ok: false, code: 'not_supported', message: '当前控制面不支持动态 token' };
    return;
  }
  const info = nodeGateway.getTokenInfoById(ctx.params.id);
  if (!info) {
    ctx.status = 404;
    ctx.body = { ok: false, code: 'not_found', message: 'token 不存在' };
    return;
  }
  if (info.official) {
    ctx.status = 403;
    ctx.body = { ok: false, code: 'forbidden', message: '不允许通过此接口撤销官方节点 token，请修改 NODE_TOKENS 环境变量' };
    return;
  }
  nodeGateway.revokeToken(info.token);
  record(user, 'token.revoke', 'token', info.id, '', ctx);
  ctx.body = { ok: true };
});

router.get('/audit', async (ctx) => {
  const user = await requireAdmin(ctx);
  if (!user) return;
  ctx.body = { ok: true, audit };
});

module.exports = { router, setAdminServices };
