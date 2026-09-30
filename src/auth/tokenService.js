'use strict';

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromBase64url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function createTokenService({ secret, ttlSeconds = 30 * 24 * 60 * 60, issuer = 'lanlink' } = {}) {
  if (!secret || String(secret).length < 16) {
    throw new Error('LANLINK_TOKEN_SECRET 至少需要 16 个字符');
  }

  function sign(data) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
  }

  function issue(user) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: issuer,
      iat: now,
      exp: now + ttlSeconds,
      user: sanitizeUser(user)
    };
    const encoded = base64url(JSON.stringify(payload));
    return `${encoded}.${sign(encoded)}`;
  }

  function verify(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encoded, signature] = parts;
    const expected = sign(encoded);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let payload;
    try {
      payload = JSON.parse(fromBase64url(encoded));
    } catch {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (!payload || payload.iss !== issuer || !payload.exp || payload.exp <= now) return null;
    if (!payload.user || !['forum', 'dev'].includes(payload.user.type)) return null;
    return payload;
  }

  function sanitizeUser(user) {
    const id = user && user.id != null ? String(user.id) : '';
    if (!id) throw new Error('缺少论坛用户 id');
    return {
      type: user && user.type === 'dev' ? 'dev' : 'forum',
      id,
      mindauth_id: user.mindauth_id == null ? null : String(user.mindauth_id),
      username: String(user.username || ''),
      display_name: String(user.display_name || user.username || ''),
      email: String(user.email || ''),
      avatar_url: String(user.avatar_url || ''),
      role: String(user.role || 'user'),
      roles: Array.isArray(user.roles) ? user.roles.map(String) : [String(user.role || 'user')],
      phone_verified: !!user.phone_verified,
      token_version: Number.isInteger(user.token_version) ? user.token_version : Number(user.token_version || 0)
    };
  }

  return { issue, verify, sanitizeUser, ttlSeconds };
}

module.exports = { createTokenService };
