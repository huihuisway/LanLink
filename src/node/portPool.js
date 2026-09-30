'use strict';

const net = require('net');

/**
 * 房间公网端口池：在多个端口范围内顺序找空闲端口（net.createServer 探测 TCP
 * 可绑定），房间关闭即回收。
 *
 * @param {{ranges:Array<{min:number, max:number}>, host?:string}} opts
 */
function createPortPool({ ranges, host = '0.0.0.0' }) {
  const inUse = new Set();

  /** 探测端口是否可绑定（TCP） */
  function probe(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, host);
    });
  }

  /** 顺序遍历所有范围，找到第一个空闲端口并标记占用 */
  async function acquire() {
    for (const { min, max } of ranges) {
      for (let port = min; port <= max; port++) {
        if (inUse.has(port)) continue;
        if (await probe(port)) {
          inUse.add(port);
          return port;
        }
      }
    }
    const desc = ranges.map((r) => `${r.min}-${r.max}`).join(',');
    throw new Error(`端口池耗尽（${desc}）`);
  }

  /** 回收端口 */
  function release(port) {
    inUse.delete(port);
  }

  return { acquire, release, inUse };
}

module.exports = { createPortPool };
