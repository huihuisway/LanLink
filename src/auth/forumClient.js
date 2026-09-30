'use strict';

const crypto = require('crypto');

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function createForumClient({ baseUrl, apiKey, quickCodePath = '/api/external/v1/lanlink/quick-code/validate', verifyPath = '/api/auth/verify', fetchImpl = fetch } = {}) {
  if (!fetchImpl) throw new Error('fetch implementation is required');

  // dev 模式：baseUrl 未配置时把识别码当作用户名（开发环境无论坛）
  if (!baseUrl) {
    return {
      async exchangeQuickCode(code) {
        const clean = String(code || 'dev').trim().slice(0, 32);
        return {
          id: `dev-${clean}`,
          mindauth_id: null,
          username: clean,
          display_name: `Dev · ${clean}`,
          email: '',
          avatar_url: '',
          role: 'user',
          roles: ['user'],
          phone_verified: true,
          token_version: 0
        };
      },
      async validateUsernamePassword(username, password) {
        // dev 模式：密码为 dev123 时放行
        if (password !== 'dev123') return null;
        const clean = String(username || 'dev').trim().slice(0, 32);
        return {
          id: `dev-${clean}`,
          mindauth_id: null,
          username: clean,
          display_name: `Dev · ${clean}`,
          email: '',
          avatar_url: '',
          role: 'user',
          roles: ['user'],
          phone_verified: true,
          token_version: 0
        };
      },
      async verifyForumSession() {
        // dev 模式：admin 接口由 dev admin 自动放行，真实 session 不再需要
        return { id: 'dev-admin', username: 'dev-admin', role: 'super_admin', roles: ['admin', 'super_admin'] };
      },
      async getLanLinkUser(userId) {
        return {
          id: String(userId || 'dev-user'),
          username: String(userId || 'dev-user'),
          display_name: `Dev · ${userId || 'user'}`,
          role: 'user',
          roles: ['user'],
          phone_verified: true,
          token_version: 0,
          type: 'dev'
        };
      },
      // dev 模式下好友/presence/通知全部返回空数据（不依赖 MindFourm）
      async getFriends() { return { friends: [] }; },
      async getFriendPresences() { return { presences: {} }; },
      async getFriendRequests() { return { requests: [] }; },
      async checkFriendship() { return false; },
      async sendNotification() { return { ok: true }; },
      async searchUsers() { return { users: [] }; },
      devMode: true
    };
  }
  async function exchangeQuickCode(code) {
    if (!baseUrl || !apiKey) throw new Error('论坛 API 未配置');
    const res = await fetchImpl(joinUrl(baseUrl, quickCodePath), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ code })
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error((body && (body.message || body.error)) || `论坛识别码校验失败 HTTP ${res.status}`);
    }
    const data = body && body.data ? body.data : body;
    if (!data || data.valid !== true || !data.user) return null;
    return {
      ...data.user,
      token_version: data.code && data.code.token_version
    };
  }

  async function verifyForumSession(sessionToken) {
    if (!baseUrl) throw new Error('论坛 API 未配置');
    const res = await fetchImpl(joinUrl(baseUrl, verifyPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_token: sessionToken })
    });
    const body = await readJson(res);
    if (!res.ok) return null;
    const data = body && body.data ? body.data : body;
    if (data && (data.valid === true || data.authenticated === true) && data.user) return data.user;
    return null;
  }

  async function getLanLinkUser(userId) {
    if (!baseUrl || !apiKey) throw new Error('论坛 API 未配置');
    const res = await fetchImpl(joinUrl(baseUrl, `/api/external/v1/lanlink/quick-code/users/${encodeURIComponent(userId)}`), {
      method: 'GET',
      headers: authHeaders()
    });
    const body = await readJson(res);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error((body && (body.message || body.error)) || `刷新论坛用户失败 HTTP ${res.status}`);
    }
    const data = body && body.data ? body.data : body;
    return data && data.user ? data.user : null;
  }

  // ---- MindFourm 外部 API：好友 / presence / 通知 / 用户搜索 ----

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };
  }

  async function getFriends(userId) {
    if (!baseUrl || !apiKey) throw new Error('论坛 API 未配置');
    const url = joinUrl(baseUrl, `/api/external/v1/friends?user_id=${encodeURIComponent(userId)}`);
    const res = await fetchImpl(url, { method: 'GET', headers: authHeaders() });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error((body && (body.message || body.error)) || `获取好友列表失败 HTTP ${res.status}`);
    }
    const data = body && body.data ? body.data : body;
    return { friends: Array.isArray(data && data.friends) ? data.friends : [] };
  }

  async function getFriendPresences(userIds) {
    if (!baseUrl || !apiKey) throw new Error('论坛 API 未配置');
    if (!Array.isArray(userIds) || userIds.length === 0) return { presences: {} };
    const ids = userIds.map(String).join(',');
    const url = joinUrl(baseUrl, `/api/external/v1/presence?user_ids=${encodeURIComponent(ids)}`);
    const res = await fetchImpl(url, { method: 'GET', headers: authHeaders() });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error((body && (body.message || body.error)) || `获取在线状态失败 HTTP ${res.status}`);
    }
    const data = body && body.data ? body.data : body;
    return { presences: (data && data.presences && typeof data.presences === 'object') ? data.presences : {} };
  }

  async function getFriendRequests(userId) {
    if (!baseUrl || !apiKey) throw new Error('论坛 API 未配置');
    const url = joinUrl(baseUrl, `/api/external/v1/friends/requests?user_id=${encodeURIComponent(userId)}`);
    const res = await fetchImpl(url, { method: 'GET', headers: authHeaders() });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error((body && (body.message || body.error)) || `获取好友请求失败 HTTP ${res.status}`);
    }
    const data = body && body.data ? body.data : body;
    return { requests: Array.isArray(data && data.requests) ? data.requests : [] };
  }

  async function checkFriendship(userId1, userId2) {
    if (!baseUrl || !apiKey) throw new Error('论坛 API 未配置');
    const url = joinUrl(baseUrl, `/api/external/v1/friends/check?user_id=${encodeURIComponent(userId1)}&friend_id=${encodeURIComponent(userId2)}`);
    const res = await fetchImpl(url, { method: 'GET', headers: authHeaders() });
    const body = await readJson(res);
    if (!res.ok) return false;
    const data = body && body.data ? body.data : body;
    return !!(data && (data.friends === true || data.is_friend === true));
  }

  async function sendNotification(userId, type, payload) {
    if (!baseUrl || !apiKey) throw new Error('论坛 API 未配置');
    const url = joinUrl(baseUrl, '/api/external/v1/notifications');
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ user_id: userId, type, payload })
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error((body && (body.message || body.error)) || `发送通知失败 HTTP ${res.status}`);
    }
    return { ok: true };
  }

  async function searchUsers(_userId, query) {
    if (!baseUrl || !apiKey) throw new Error('论坛 API 未配置');
    const url = joinUrl(baseUrl, `/api/external/v1/users/search?user_id=${encodeURIComponent(_userId)}&q=${encodeURIComponent(query || '')}`);
    const res = await fetchImpl(url, { method: 'GET', headers: authHeaders() });
    const body = await readJson(res);
    if (!res.ok) {
      throw new Error((body && (body.message || body.error)) || `搜索用户失败 HTTP ${res.status}`);
    }
    const data = body && body.data ? body.data : body;
    return { users: Array.isArray(data && data.users) ? data.users : [] };
  }

  async function validateUsernamePassword(username, password) {
    if (!baseUrl || !apiKey) throw new Error('论坛 API 未配置');

    // 生成用户标识（hash用户名），让MindFourm按用户限流而非按IP
    const userIdentifier = crypto.createHash('sha256')
      .update(`lanlink-user:${username.toLowerCase()}`)
      .digest('hex')
      .slice(0, 16);

    const res = await fetchImpl(joinUrl(baseUrl, '/api/auth/validate-credentials'), {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'X-User-Identifier': userIdentifier
      },
      body: JSON.stringify({ username, password })
    });
    const body = await readJson(res);
    if (!res.ok) {
      if (res.status === 401) return null; // 密码错误
      throw new Error((body && (body.message || body.error)) || `论坛验证失败 HTTP ${res.status}`);
    }
    const data = body && body.data ? body.data : body;
    if (!data || data.valid !== true || !data.user) return null;
    return {
      ...data.user,
      token_version: data.user.token_version || 0
    };
  }

  return {
    exchangeQuickCode,
    verifyForumSession,
    getLanLinkUser,
    validateUsernamePassword,
    getFriends,
    getFriendPresences,
    getFriendRequests,
    checkFriendship,
    sendNotification,
    searchUsers,
    devMode: false
  };
}

module.exports = { createForumClient, joinUrl };
