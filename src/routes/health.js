'use strict';

const Router = require('@koa/router');

const router = new Router();

// 在线节点数由 app.js 装配时注入（避免路由层直接依赖 WS 网关）
let getOnlineNodeCount = () => 0;

function setNodeCounter(fn) {
  getOnlineNodeCount = fn;
}

router.get('/', async (ctx) => {
  // 懒加载 db，避免仅 require 路由就建立连接
  const db = require('../db');

  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '0.1.0',
    services: {}
  };

  // 这个接口不需要认证，因此不能回显驱动的原始错误
  // （里面含主机名、端口、内网 IP）。详情只记到服务端日志。
  try {
    await db.mysql.getOne('SELECT 1 AS test');
    health.services.mysql = 'connected';
  } catch (err) {
    console.error('[health] MySQL check failed:', err.message);
    health.status = 'degraded';
    health.services.mysql = 'error';
  }

  try {
    await db.redis.redis.ping();
    health.services.redis = 'connected';
  } catch (err) {
    console.error('[health] Redis check failed:', err.message);
    health.status = 'degraded';
    health.services.redis = 'error';
  }

  // 在线节点数只报数字，不参与降级（节点可以晚于控制面上线）
  health.services.nodes_online = getOnlineNodeCount();

  ctx.status = health.status === 'ok' ? 200 : 503;
  ctx.body = health;
});

module.exports = { router, setNodeCounter };
