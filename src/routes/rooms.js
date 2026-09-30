'use strict';

const Router = require('@koa/router');

const router = new Router();

// 房间注册表由 app.js / tests 装配时注入，避免路由层直接依赖 WS 网关。
let lookupRoom = () => null;
let listRooms = () => [];

function setRoomLookup(fn) {
  lookupRoom = typeof fn === 'function' ? fn : () => null;
}

function setRoomLister(fn) {
  listRooms = typeof fn === 'function' ? fn : () => [];
}

function summarizeRoom(room) {
  const out = {
    code: room.code,
    name: room.name || '',
    display_name: room.displayName || '',
    public: !!room.isPublic,
    owner: room.owner || { type: 'anonymous', display_name: '匿名房主' },
    node: {
      id: room.nodeId,
      name: room.nodeName || room.nodeId,
      addr: room.nodeAddr,
      room_port: room.roomPort
    }
  };
  // direct 单对象：规范化为 {mode, addr, port} 保持向后兼容
  if (room.direct) {
    const port = room.direct.tcp_port || room.direct.udp_port || room.direct.port || 0;
    out.direct = { mode: room.direct.mode, addr: room.direct.addr, port };
  }
  // direct_candidates 数组（M2）
  if (Array.isArray(room.directCandidates) && room.directCandidates.length > 0) {
    out.direct_candidates = room.directCandidates.map((c) => ({
      mode: c.mode,
      addr: c.addr,
      port: c.tcp_port || c.udp_port || 0
    }));
  }
  return out;
}

router.get('/public', async (ctx) => {
  const rooms = listRooms()
    .filter((room) => room.isPublic && !room.hidden && room.roomPort)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  ctx.body = {
    rooms: rooms.map(summarizeRoom)
  };
});

router.get('/:code', async (ctx) => {
  const code = String(ctx.params.code || '').trim().toUpperCase();
  const room = code ? lookupRoom(code) : null;
  if (!room || !room.roomPort) {
    ctx.status = 404;
    ctx.body = { success: false, message: '房间不存在或已关闭' };
    return;
  }

  ctx.body = summarizeRoom(room);
});

module.exports = { router, setRoomLookup, setRoomLister, summarizeRoom };
