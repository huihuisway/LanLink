'use strict';

const Router = require('@koa/router');
const health = require('./health');
const versionRouter = require('./version');
const nodes = require('./nodes');
const rooms = require('./rooms');
const auth = require('./auth');
const admin = require('./admin');
const friends = require('./friends');

const router = new Router({ prefix: '/api' });

router.use('/health', health.router.routes(), health.router.allowedMethods());
router.use('/version', versionRouter.routes(), versionRouter.allowedMethods());
router.use('/nodes', nodes.router.routes(), nodes.router.allowedMethods());
router.use('/rooms', rooms.router.routes(), rooms.router.allowedMethods());
router.use('/auth', auth.router.routes(), auth.router.allowedMethods());
router.use('/admin', admin.router.routes(), admin.router.allowedMethods());
router.use(friends.router.routes(), friends.router.allowedMethods());

// API 根路由
router.get('/', async (ctx) => {
  ctx.body = {
    success: true,
    message: 'LanLink API',
    version: '0.1.0',
    endpoints: ['/health', '/version', '/nodes/available', '/rooms/:code', '/rooms/public', '/auth/code/exchange', '/auth/me', '/auth/refresh', '/auth/device/start', '/auth/device/poll', '/friends', '/friends/requests', '/invites/send', '/invites/respond', '/admin/rooms']
  };
});

module.exports = router;
