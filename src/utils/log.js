'use strict';

/**
 * 归一化日志对象：补齐缺失的方法。
 *
 * 数据面（relay）在处理客人连接/数据包时打日志，若调用方传入的 logger 缺少某个
 * 方法（如只有 log/warn/error 的桩），会在收包路径上抛异常并打断连接。
 * 日志能力残缺不应影响转发，故统一在入口归一化。
 */
const NOOP = () => {};

function normalizeLog(log) {
  if (!log) return { info: NOOP, log: NOOP, warn: NOOP, error: NOOP, debug: NOOP };
  const base = typeof log.log === 'function' ? log.log.bind(log) : NOOP;
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : base,
    log: base,
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : base,
    error: typeof log.error === 'function' ? log.error.bind(log) : base,
    debug: typeof log.debug === 'function' ? log.debug.bind(log) : NOOP
  };
}

module.exports = { normalizeLog };
