'use strict';

const Router = require('@koa/router');
const config = require('../config');

const router = new Router();

// PROTOCOL.md §4: {"latest":"0.1.0","url":"<MindFileList 下载页>","min":"0.1.0"}
router.get('/', async (ctx) => {
  ctx.body = {
    latest: config.version.latest,
    url: config.version.url,
    min: config.version.min
  };
});

module.exports = router;
