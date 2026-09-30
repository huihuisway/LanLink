'use strict';

/**
 * Centralized Redis key names used by the control plane.
 * Keep these builders pure so callers can share keys without importing a Redis client.
 */
const roomKey = (code) => `lanlink:room:${code}`;
const nodeKey = (id) => `lanlink:node:${id}`;
const inviteKey = (userId, roomCode) => `lanlink:invite:${userId}:${roomCode}`;
const loginIpLimitKey = (ip) => `lanlink:login:ip:${ip}`;
const loginUserLimitKey = (username) => `lanlink:login:user:${username}`;
const deviceSessionKey = (sessionId) => `lanlink:auth:device:${sessionId}`;
// Read-only compatibility for device sessions created before key names were centralized.
const legacyDeviceSessionKey = (sessionId) => `lanlink-device:${sessionId}`;
const refreshLimitKey = (userId) => `lanlink:auth:refresh:${userId}`;
const presenceKey = (userId, prefix = 'lanlink:presence:') => `${prefix}${userId}`;

module.exports = {
  roomKey,
  nodeKey,
  inviteKey,
  loginIpLimitKey,
  loginUserLimitKey,
  deviceSessionKey,
  legacyDeviceSessionKey,
  refreshLimitKey,
  presenceKey
};
