'use strict';

/**
 * 控制面选点：
 * - 指定 node_id：按 id 精确匹配
 * - 手填 relay_addr（可附 relay_tunnel_port）：按地址/隧道端口匹配在线节点
 * - 都没指定：回退到自动选点
 *
 * @param {Array<object>} onlineNodes nodeSocket.onlineNodes() 的结果
 * @returns {object|null}
 */
function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePort(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const port = Number(value.trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

function hasNodeSelection({ nodeId, relayAddr } = {}) {
  return normalizeText(nodeId) !== '' || normalizeText(relayAddr) !== '';
}

function pickRequestedNode(onlineNodes, { nodeId, relayAddr, relayTunnelPort } = {}) {
  if (!Array.isArray(onlineNodes) || onlineNodes.length === 0) return null;

  const wantedId = normalizeText(nodeId);
  if (wantedId) return onlineNodes.find((node) => node.id === wantedId) || null;

  const wantedAddr = normalizeText(relayAddr);
  if (!wantedAddr) return null;

  const wantedTunnelPort = normalizePort(relayTunnelPort);
  const sameAddr = onlineNodes.filter((node) => normalizeText(node.addr) === wantedAddr);

  if (wantedTunnelPort == null) {
    return sameAddr.length === 1 ? sameAddr[0] : null;
  }

  return sameAddr.find((node) => normalizePort(node.tunnelPort) === wantedTunnelPort) || null;
}

function pickNode(onlineNodes) {
  if (!Array.isArray(onlineNodes) || onlineNodes.length === 0) return null;
  if (onlineNodes.length === 1) return onlineNodes[0];
  const maxRooms = Math.max(1, ...onlineNodes.map((node) => Number(node.stats && node.stats.rooms) || 0));
  const maxSessions = Math.max(1, ...onlineNodes.map((node) => Number(node.stats && node.stats.sessions) || 0));
  const maxMbps = Math.max(1, ...onlineNodes.map((node) => Number(node.stats && node.stats.mbpsUsed) || 0));
  const score = (node) => {
    const stats = node.stats || {};
    return (Number(stats.sessions) || 0) / maxSessions * 0.50
      + (Number(stats.rooms) || 0) / maxRooms * 0.30
      + (Number(stats.mbpsUsed) || 0) / maxMbps * 0.20;
  };
  return [...onlineNodes].sort((a, b) => score(a) - score(b))[0];
}

module.exports = { hasNodeSelection, pickRequestedNode, pickNode };
