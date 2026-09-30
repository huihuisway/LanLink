'use strict';

const net = require('net');

function normalizeIp(value) {
  if (typeof value !== 'string') return null;

  let ip = value.trim();
  if (!ip) return null;

  const bracketed = ip.match(/^\[([^\]]+)\]$/);
  if (bracketed) ip = bracketed[1];

  if (ip.length > 45 || !net.isIP(ip)) return null;

  const ipv4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (ipv4Mapped) return ipv4Mapped[1];

  return ip.toLowerCase();
}

/**
 * 从请求头中解析客户端真实 IP
 * 优先级：ali-real-client-ip → x-real-ip → cf-connecting-ip → x-forwarded-for[0] → socket peer
 * @param {object} headers - 请求头对象
 * @param {string} connectionIp - socket 对端 IP
 * @returns {{ip: string, source: 'header' | 'socket'}}
 */
function resolveClientIp(headers, connectionIp) {
  const headerPriority = ['ali-real-client-ip', 'x-real-ip', 'cf-connecting-ip'];

  // 优先检查单值头
  for (const headerName of headerPriority) {
    const value = headers[headerName];
    const normalized = normalizeIp(value);
    if (normalized) {
      return { ip: normalized, source: 'header' };
    }
  }

  // 然后检查 x-forwarded-for（多值，取第一个）
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const firstIp = xff.split(',').map(v => v.trim()).find(Boolean);
    const normalized = normalizeIp(firstIp);
    if (normalized) {
      return { ip: normalized, source: 'header' };
    }
  }

  // 回退到 socket peer
  return {
    ip: normalizeIp(connectionIp) || connectionIp || 'unknown',
    source: 'socket'
  };
}

function createClientIpMiddleware() {
  return async (ctx, next) => {
    const { ip, source } = resolveClientIp(
      ctx.request.header,
      ctx.request.socket.remoteAddress
    );

    ctx.state.realIp = ip;
    ctx.state.clientIpSource = source;
    Object.defineProperty(ctx.request, 'ip', { value: ip, configurable: true });

    await next();
  };
}

module.exports = {
  createClientIpMiddleware,
  normalizeIp,
  resolveClientIp
};
