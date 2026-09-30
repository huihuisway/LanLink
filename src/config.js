'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');
const { parseNodeAccessConfig } = require('./control/nodeAccess');

// 安全：所有密钥必须从环境变量配置，不允许硬编码默认值；
// 开发环境用 .env 文件配置。
const requiredInProduction = (envVar, defaultValue = null) => {
  if (process.env.NODE_ENV === 'production' && !process.env[envVar]) {
    throw new Error(`${envVar} 必须在生产环境中配置`);
  }
  return process.env[envVar] || defaultValue;
};

// 解析社区节点 token 配置：优先读文件，fallback 到环境变量 JSON
function parseCommunityTokenConfig() {
  const file = process.env.COMMUNITY_TOKENS_FILE;
  let raw = null;
  if (file) {
    try {
      const resolved = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
      raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // eslint-disable-next-line no-console
        console.warn(`[config] failed to read COMMUNITY_TOKENS_FILE: ${err.message}`);
      }
    }
  }
  if (!raw && process.env.COMMUNITY_TOKENS_JSON) {
    try {
      raw = JSON.parse(process.env.COMMUNITY_TOKENS_JSON);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[config] failed to parse COMMUNITY_TOKENS_JSON: ${err.message}`);
    }
  }
  if (!raw || !Array.isArray(raw.tokens)) return { tokens: [] };
  const tokens = raw.tokens
    .filter((e) => e && typeof e.token === 'string' && e.token.length >= 16)
    .map((e) => ({
      token: String(e.token),
      id: e.id ? String(e.id) : '',
      name: String(e.name || ''),
      owner: String(e.owner || ''),
      region: String(e.region || ''),
      tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
      description: String(e.description || ''),
      official: false,
      createdAt: e.createdAt || Date.now()
    }));
  return { tokens };
}

module.exports = {
  port: parseInt(process.env.PORT) || 5100,

  // 协议版本（PROTOCOL.md v2）
  // v1：初始版本
  // v2：强制版本检查，旧版本 Mod 将被拒绝连接
  protocolVersion: 2,

  motd: process.env.MOTD || '欢迎使用 LanLink 联机中继',

  // 控制面/服务端自身版本，用于 hello_ok 与房间展示标识。
  serverVersion: process.env.LANLINK_SERVER_VERSION || packageJson.version,

  // GET /api/version 与 hello_ok 使用
  version: {
    latest: process.env.VERSION_LATEST || '0.13.0',
    min: process.env.VERSION_MIN || '0.13.0',
    url: process.env.VERSION_URL || 'https://mindfilelist.example.com/lanlink'
  },

  // 节点 token 白名单（逗号分隔；第 i 个 token 对应节点 id node-i）
  nodeTokens: (requiredInProduction('NODE_TOKENS', '') || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),

  // 社区节点 token 配置（JSON 文件或环境变量）
  communityNodeTokens: parseCommunityTokenConfig(),

  // P2P / 直连配置（M2）
  p2p: {
    // 控制面提供给 Mod 的推荐 STUN 服务器（Mod 也会内置默认值，这里仅作覆盖）
    stunServers: (process.env.STUN_SERVERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  },

  // 论坛登录桥接：论坛生成 LanLink 识别码，控制面兑换为 LanLink token。
  forum: {
    baseUrl: process.env.FORUM_BASE_URL || '',
    externalApiKey: requiredInProduction('FORUM_EXTERNAL_API_KEY', ''),
    quickCodePath: process.env.FORUM_QUICK_CODE_PATH || '/api/external/v1/lanlink/quick-code/validate',
    verifyPath: process.env.FORUM_VERIFY_ENDPOINT || '/api/auth/verify',
    verificationPageUrl: process.env.FORUM_VERIFICATION_PAGE_URL || ''
  },

  // MindAuth 设备授权流（Phase C）：baseUrl 未配置时 /api/auth/device/* 返回 503
  mindauth: {
    baseUrl: process.env.MINDAUTH_BASE_URL || '',
    clientId: process.env.MINDAUTH_CLIENT_ID || 'lanlink-mod',
    clientSecret: process.env.MINDAUTH_CLIENT_SECRET || ''
  },

  auth: {
    tokenSecret: requiredInProduction('LANLINK_TOKEN_SECRET', process.env.LANLINK_TOKEN_SECRET || 'dev-lanlink-token-secret'),
    tokenTtlSeconds: parseInt(process.env.LANLINK_TOKEN_TTL_SECONDS) || 30 * 24 * 60 * 60
  },

  // MySQL 配置
  mysql: {
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'lanlink',
    connectionLimit: parseInt(process.env.MYSQL_POOL_SIZE) || 10
  },

  // Redis 配置
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || '',
    db: parseInt(process.env.REDIS_DB) || 0
  },

  // 房间：房主 WS 断开后的宽限期
  room: {
    graceMs: parseInt(process.env.ROOM_GRACE_MS) || 60000
  },

  // 节点管理
  node: {
    heartbeatTimeoutMs: parseInt(process.env.NODE_HEARTBEAT_TIMEOUT_MS) || 30000,
    sweepMs: parseInt(process.env.NODE_SWEEP_MS) || 5000,
    openTimeoutMs: parseInt(process.env.NODE_OPEN_TIMEOUT_MS) || 10000,
    access: parseNodeAccessConfig(process.env.NODE_ACCESS_CONFIG_JSON)
  }
};
