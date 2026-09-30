'use strict';

function bearerToken(ctx) {
  const header = ctx.get ? ctx.get('authorization') : (ctx.headers && ctx.headers.authorization);
  if (!header || typeof header !== 'string') return '';
  const [type, token] = header.split(' ');
  return type === 'Bearer' && token ? token.trim() : '';
}

function userFromToken(tokenService, token) {
  if (!tokenService || !token) return null;
  const payload = tokenService.verify(token);
  return payload && payload.user ? payload.user : null;
}

function createCurrentUserMiddleware({ tokenService } = {}) {
  return async (ctx, next) => {
    ctx.state.user = userFromToken(tokenService, bearerToken(ctx));
    await next();
  };
}

module.exports = { bearerToken, userFromToken, createCurrentUserMiddleware };
