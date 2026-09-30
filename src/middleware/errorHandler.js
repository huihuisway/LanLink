'use strict';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * 全局错误处理
 *
 * 未捕获的异常（MySQL 报错、含绝对路径的 ENOENT 等）直接回显 err.message
 * 会泄露内部结构，生产环境统一返回通用文案。
 * 4xx 属于业务错误，文案是我们自己写的，可以照常返回。
 */
async function errorHandler(ctx, next) {
  try {
    await next();
  } catch (err) {
    console.error('Error:', err);

    const status = err.status || 500;
    ctx.status = status;

    const isClientError = status >= 400 && status < 500;
    const message = (isClientError || !isProduction)
      ? (err.message || '服务器错误')
      : '服务器错误';

    ctx.body = {
      success: false,
      message
    };
  }
}

module.exports = errorHandler;
