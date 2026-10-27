/**
 * API 辅助工具 - 统一的响应格式和错误处理
 */

function getRequestId(req) {
  return req?.headers?.['x-request-id'] || req?.id || null;
}

function responseMeta(req = null, extra = {}) {
  return {
    requestId: getRequestId(req),
    dryRun: false,
    ...extra
  };
}

export function agentError(code, message, options = {}) {
  const error = new Error(message || code || '操作失败');
  error.code = code || 'AGENT_INTERNAL_ERROR';
  error.statusCode = options.statusCode || options.status || 500;
  error.details = options.details || {};
  error.retryable = options.retryable ?? false;
  return error;
}

/**
 * 成功响应
 */
export function successResponse(data, message = '操作成功', meta = {}) {
  return {
    success: true,
    message,
    data,
    meta: responseMeta(null, meta)
  };
}

/**
 * 错误响应
 */
export function errorResponse(error, message, meta = {}) {
  const normalized = typeof error === 'string'
    ? agentError('AGENT_INTERNAL_ERROR', error)
    : error;

  return {
    success: false,
    message: message || normalized?.message || '操作失败',
    error: {
      code: normalized?.code || 'AGENT_INTERNAL_ERROR',
      details: normalized?.details || {},
      retryable: normalized?.retryable ?? false
    },
    meta: responseMeta(null, meta)
  };
}

export function sendSuccess(res, req, data, message = '操作成功', meta = {}) {
  res.json({
    success: true,
    message,
    data,
    meta: responseMeta(req, meta)
  });
}

export function sendDryRun(res, req, plan, message = 'Dry run only', meta = {}) {
  sendSuccess(res, req, { plan }, message, { ...meta, dryRun: true });
}

export function sendError(res, req, error, fallbackMessage, meta = {}) {
  const normalized = typeof error === 'string'
    ? agentError('AGENT_INTERNAL_ERROR', error)
    : error;
  const status = normalizeErrorStatus(normalized?.statusCode ?? normalized?.status);
  res.status(status).json({
    success: false,
    message: fallbackMessage || normalized?.message || '操作失败',
    error: {
      code: normalized?.code || 'AGENT_INTERNAL_ERROR',
      details: normalized?.details || {},
      retryable: normalized?.retryable ?? false
    },
    meta: responseMeta(req, meta)
  });
}

/**
 * 异步处理器包装 - 通过 next(error) 交给统一错误出口
 */
export function asyncHandler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * HTTP 状态归一：错误响应状态限制在 400-599，其余一律按 500 处理
 */
function normalizeErrorStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

/**
 * 请求框架错误（body 解析等）到稳定 JSON 错误的映射
 */
const REQUEST_FRAMEWORK_ERRORS = [
  {
    type: 'entity.parse.failed',
    code: 'AGENT_REQUEST_BODY_INVALID',
    message: '请求体不是有效的 JSON',
    status: 400
  },
  {
    type: 'entity.too.large',
    code: 'AGENT_REQUEST_BODY_TOO_LARGE',
    message: '请求体超过允许的大小',
    status: 413
  },
  {
    type: 'charset.unsupported',
    code: 'AGENT_REQUEST_CHARSET_UNSUPPORTED',
    message: '请求字符集不支持',
    status: 415
  }
];

function mapRequestFrameworkError(error) {
  return REQUEST_FRAMEWORK_ERRORS.find(mapping => error?.type === mapping.type) || null;
}

/**
 * 路由参数解码失败（Express 对畸形百分号编码抛出带 400 状态的 URIError）
 */
function isPathParamDecodeError(error) {
  return error instanceof URIError && (error.status === 400 || error.statusCode === 400);
}

function logApiError(req, status, code, message = null) {
  // 记录不含查询串的完整路径，日志不回显 query 中的敏感参数
  const original = typeof req?.originalUrl === 'string'
    ? req.originalUrl
    : (typeof req?.url === 'string' ? req.url : null);
  const pathWithoutQuery = original
    ? original.split('?')[0]
    : (req?.path || '(unknown path)');
  const line = `[API] ${req?.method || 'UNKNOWN'} ${pathWithoutQuery} -> ${status} ${code}`;
  if (message) {
    console.error(`${line} ${message}`);
  } else {
    console.error(line);
  }
}

/**
 * 统一 API 错误出口：
 * - 已发送响应头后交回错误链；
 * - 请求框架错误映射为稳定 JSON 错误；
 * - 携带 400-599 状态的业务错误保留公开 code/message/details/retryable；
 * - 未知内部错误统一为 500，不泄露 message/details/堆栈。
 */
export function apiErrorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  const frameworkError = mapRequestFrameworkError(error);
  if (frameworkError) {
    logApiError(req, frameworkError.status, frameworkError.code, frameworkError.message);
    return sendError(res, req, agentError(frameworkError.code, frameworkError.message, {
      statusCode: frameworkError.status
    }));
  }

  if (isPathParamDecodeError(error)) {
    logApiError(req, 400, 'AGENT_REQUEST_PATH_INVALID');
    return sendError(res, req, agentError('AGENT_REQUEST_PATH_INVALID', '请求路径参数无法解码', {
      statusCode: 400
    }));
  }

  const rawStatus = Number(error?.statusCode ?? error?.status);
  const declaredStatus = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : null;

  if (declaredStatus !== null) {
    logApiError(req, declaredStatus, error.code || 'AGENT_INTERNAL_ERROR', error.message);
    return sendError(res, req, error);
  }

  logApiError(req, 500, 'AGENT_INTERNAL_ERROR');
  return sendError(res, req, agentError('AGENT_INTERNAL_ERROR', '服务器内部错误', {
    statusCode: 500
  }));
}

/**
 * 验证必需参数
 */
export function validateRequired(data, requiredFields) {
  const missing = requiredFields.filter(field => !data[field]);
  if (missing.length > 0) {
    throw agentError('AGENT_VALIDATION_MISSING_FIELDS', `缺少必需参数: ${missing.join(', ')}`, {
      statusCode: 400,
      details: { missingFields: missing },
      retryable: false
    });
  }
}

/**
 * 安全的 JSON 解析
 */
export function safeJsonParse(str, defaultValue = null) {
  try {
    return JSON.parse(str);
  } catch (error) {
    console.error('JSON 解析失败:', error.message);
    return defaultValue;
  }
}
