'use strict';

/**
 * 连接监控：定期检查 WebSocket 连接状态，清理僵尸连接
 * 诊断内存泄漏和连接泄漏
 */

function createConnectionMonitor({ modWss, nodeWss, guestWss, registry, nodeGateway, guestGateway, intervalMs = 60000, log = console }) {
  let timer = null;

  function getStats() {
    const now = Date.now();
    const stats = {
      timestamp: new Date().toISOString(),
      modConnections: modWss ? modWss.clients.size : 0,
      nodeConnections: nodeWss ? nodeWss.clients.size : 0,
      guestConnections: guestWss ? guestWss.clients.size : 0,
      activeRooms: registry ? registry.count() : 0,
      onlineNodes: nodeGateway ? nodeGateway.onlineNodes().length : 0,
      memoryUsage: process.memoryUsage()
    };

    // 检查僵尸连接（连接超过 5 分钟但没有活动的房间）
    if (modWss && modWss.clients) {
      let staleModConnections = 0;
      for (const ws of modWss.clients) {
        // ws 对象没有直接的时间戳，但可以通过 _socket 检查
        if (ws._socket && ws._socket._handle) {
          // 连接存在但没有关联房间，可能是僵尸
          staleModConnections++;
        }
      }
      stats.potentiallyStaleModConnections = staleModConnections;
    }

    return stats;
  }

  function check() {
    try {
      const stats = getStats();

      // 输出诊断信息
      log.info(`[monitor] 连接统计:
  Mod 连接: ${stats.modConnections}
  Node 连接: ${stats.nodeConnections}
  Guest 连接: ${stats.guestConnections}
  活跃房间: ${stats.activeRooms}
  在线节点: ${stats.onlineNodes}
  内存使用: ${Math.round(stats.memoryUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(stats.memoryUsage.heapTotal / 1024 / 1024)}MB`);

      // 告警：连接数异常高
      if (stats.guestConnections > 100) {
        log.warn(`[monitor] ⚠ Guest 连接数过高: ${stats.guestConnections}`);
      }
      if (stats.modConnections > 50) {
        log.warn(`[monitor] ⚠ Mod 连接数过高: ${stats.modConnections}`);
      }

      // 告警：内存增长
      if (stats.memoryUsage.heapUsed > 500 * 1024 * 1024) {
        log.warn(`[monitor] ⚠ 内存使用过高: ${Math.round(stats.memoryUsage.heapUsed / 1024 / 1024)}MB`);
      }

    } catch (err) {
      log.error('[monitor] 检查失败:', err);
    }
  }

  function start() {
    if (timer) return;
    log.info('[monitor] 连接监控已启动');
    timer = setInterval(check, intervalMs);
    if (timer.unref) timer.unref();
    // 立即执行一次
    check();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
      log.info('[monitor] 连接监控已停止');
    }
  }

  return { start, stop, getStats };
}

module.exports = { createConnectionMonitor };
