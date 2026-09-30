/**
 * API响应格式统一工具
 * 确保所有API返回一致的响应结构
 */

/**
 * 成功响应格式
 * @param {object} data - 返回数据
 * @param {string} message - 成功消息（可选）
 * @returns {object} - 标准响应对象
 */
function successResponse(data, message = '操作成功') {
  return {
    success: true,
    data,
    message,
    timestamp: Date.now()
  };
}

/**
 * 失败响应格式
 * @param {string} message - 错误消息
 * @param {number} code - 错误码（可选）
 * @param {string} error - 详细错误（仅开发环境）
 * @returns {object} - 标准响应对象
 */
function errorResponse(message, code = null, error = null) {
  const response = {
    success: false,
    message,
    timestamp: Date.now()
  };

  if (code) {
    response.code = code;
  }

  // 仅在开发环境返回详细错误
  if (error && process.env.NODE_ENV !== 'production') {
    response.error = error;
  }

  return response;
}

/**
 * 分页响应格式
 * @param {Array} items - 数据列表
 * @param {number} total - 总数量
 * @param {number} page - 当前页
 * @param {number} pageSize - 每页数量
 * @returns {object} - 标准分页响应对象
 */
function paginatedResponse(items, total, page = 1, pageSize = 20) {
  return {
    success: true,
    data: {
      items,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
      }
    },
    timestamp: Date.now()
  };
}

/**
 * HTTP状态码映射
 */
const STATUS_CODES = {
  // 成功
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,

  // 客户端错误
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,

  // 服务端错误
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503
};

/**
 * 根据错误类型返回合适的HTTP状态码
 * @param {string} message - 错误消息
 * @returns {number} - HTTP状态码
 */
function getStatusCode(message) {
  if (message.includes('未认证') || message.includes('Unauthorized')) {
    return STATUS_CODES.UNAUTHORIZED;
  }
  if (message.includes('无权') || message.includes('permission')) {
    return STATUS_CODES.FORBIDDEN;
  }
  if (message.includes('不存在') || message.includes('not found')) {
    return STATUS_CODES.NOT_FOUND;
  }
  if (message.includes('无效') || message.includes('invalid') || message.includes('缺少')) {
    return STATUS_CODES.BAD_REQUEST;
  }
  if (message.includes('正在') || message.includes('too many')) {
    return STATUS_CODES.TOO_MANY_REQUESTS;
  }
  return STATUS_CODES.INTERNAL_ERROR;
}

module.exports = {
  successResponse,
  errorResponse,
  paginatedResponse,
  STATUS_CODES,
  getStatusCode
};
