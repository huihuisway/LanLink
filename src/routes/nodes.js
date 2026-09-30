'use strict';

const Router = require('@koa/router');
const { bearerToken, userFromToken } = require('../middleware/currentUser');
const { canUseNode } = require('../control/nodeAccess');

const router = new Router();

// 在线节点列表由 app.js 装配时注入（避免路由层直接依赖 WS 网关）
let listOnlineNodes = () => [];
let tokenService = null;
let accessConfig = { defaultAccess: 'anonymous', nodes: {} };

function setNodeLister(fn) {
  listOnlineNodes = typeof fn === 'function' ? fn : () => [];
}

function setNodeAccessServices(services = {}) {
  tokenService = services.tokenService || null;
  accessConfig = services.accessConfig || accessConfig;
}

function summarizeNode(node, user = null) {
  const access = canUseNode(node, user, accessConfig);
  return {
    id: node.id,
    name: node.name || node.id,
    addr: node.addr || '',
    tunnel_port: node.tunnelPort || 0,
    rooms: (node.stats && node.stats.rooms) || 0,
    sessions: (node.stats && node.stats.sessions) || 0,
    mbps_used: (node.stats && node.stats.mbpsUsed) || 0,
    access: access.policy.access,
    requires_login: access.policy.access === 'login',
    usable: access.usable,
    reason: access.reason,
    region: node.region || access.policy.region,
    tags: Array.isArray(node.tags) && node.tags.length > 0 ? node.tags : access.policy.tags,
    // M2 社区节点字段
    official: node.official !== false,
    owner: node.owner || '',
    description: node.description || ''
  };
}

router.get('/available', async (ctx) => {
  const user = userFromToken(tokenService, bearerToken(ctx));
  ctx.body = {
    nodes: listOnlineNodes().map((node) => summarizeNode(node, user))
  };
});

module.exports = { router, setNodeLister, setNodeAccessServices, summarizeNode };
