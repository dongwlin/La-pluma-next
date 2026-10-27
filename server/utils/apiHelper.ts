/**
 * API 辅助工具 - 统一的响应格式和错误处理
 */

/** Express NextFunction 的最小结构端口，仅约束错误透传调用。 */
export type NextLike = (error?: unknown) => void;

/**
 * 响应/日志端口读取的最小请求结构。
 * 只声明本工具实际读取的字段，第三方 Request 的宽松类型不由此向外扩散。
 */
export interface ApiRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  id?: string | number;
  method?: unknown;
  url?: unknown;
  originalUrl?: unknown;
  path?: unknown;
  query?: unknown;
}

export type MaybeApiRequest = ApiRequestLike | null | undefined;

/** 仅支持 res.json 的响应端口（sendSuccess 使用）。 */
export interface JsonResponseWriter {
  json(body: object): unknown;
}

/** 支持 res.status().json() 链式写入的响应端口（sendError 使用）。 */
export interface StatusableJsonWriter extends JsonResponseWriter {
  status(statusCode: number): JsonResponseWriter;
}

/** 错误出口使用的响应端口，额外要求可读的 headersSent。 */
export interface ApiResponseWriter extends StatusableJsonWriter {
  headersSent: boolean;
}

export interface AgentErrorOptions {
  statusCode?: number;
  status?: number;
  details?: Record<string, unknown>;
  retryable?: boolean;
}

/** agentError 产出的结构化错误：公开字段固定为 code/statusCode/details/retryable。 */
export interface AgentError extends Error {
  code: string;
  statusCode: number;
  details: Record<string, unknown>;
  retryable: boolean;
}

export interface ResponseMeta extends Record<string, unknown> {
  requestId: string | number | string[] | null;
  dryRun: boolean;
}

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  message: string;
  data: T;
  meta: ResponseMeta;
}

export interface ApiErrorDetail {
  code: string;
  details: Record<string, unknown>;
  retryable: boolean;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  error: ApiErrorDetail;
  meta: ResponseMeta;
}

/** 读取未知错误对象上的可选字段；非对象输入一律视为缺失。 */
interface ErrorFields {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  retryable?: unknown;
  statusCode?: unknown;
  status?: unknown;
  type?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorFields(value: unknown): value is ErrorFields {
  return typeof value === 'object' && value !== null;
}

function errorFieldsOf(error: unknown): ErrorFields {
  return isErrorFields(error) ? error : {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asDetails(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asRetryable(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

function getRequestId(req: MaybeApiRequest): string | number | string[] | null {
  return req?.headers?.['x-request-id'] || req?.id || null;
}

function responseMeta(req: MaybeApiRequest = null, extra: Record<string, unknown> = {}): ResponseMeta {
  return {
    requestId: getRequestId(req),
    dryRun: false,
    ...extra
  };
}

export function agentError(code?: string, message?: string, options: AgentErrorOptions = {}): AgentError {
  const error: AgentError = Object.assign(new Error(message || code || '操作失败'), {
    code: code || 'AGENT_INTERNAL_ERROR',
    statusCode: options.statusCode || options.status || 500,
    details: options.details || {},
    retryable: options.retryable ?? false,
  });
  return error;
}

/**
 * 成功响应
 */
export function successResponse<T>(data: T, message = '操作成功', meta: Record<string, unknown> = {}): ApiSuccessResponse<T> {
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
export function errorResponse(error: unknown, message?: string, meta: Record<string, unknown> = {}): ApiErrorResponse {
  const normalized = typeof error === 'string'
    ? agentError('AGENT_INTERNAL_ERROR', error)
    : error;
  const fields = errorFieldsOf(normalized);

  return {
    success: false,
    message: message || asText(fields.message) || '操作失败',
    error: {
      code: asText(fields.code) || 'AGENT_INTERNAL_ERROR',
      details: asDetails(fields.details),
      retryable: asRetryable(fields.retryable)
    },
    meta: responseMeta(null, meta)
  };
}

export function sendSuccess<T>(res: JsonResponseWriter, req: MaybeApiRequest, data: T, message = '操作成功', meta: Record<string, unknown> = {}): void {
  res.json({
    success: true,
    message,
    data,
    meta: responseMeta(req, meta)
  });
}

export function sendDryRun(res: JsonResponseWriter, req: MaybeApiRequest, plan: unknown, message = 'Dry run only', meta: Record<string, unknown> = {}): void {
  sendSuccess(res, req, { plan }, message, { ...meta, dryRun: true });
}

export function sendError(res: StatusableJsonWriter, req: MaybeApiRequest, error: unknown, fallbackMessage?: string, meta: Record<string, unknown> = {}): void {
  const normalized = typeof error === 'string'
    ? agentError('AGENT_INTERNAL_ERROR', error)
    : error;
  const fields = errorFieldsOf(normalized);
  const status = normalizeErrorStatus(fields.statusCode ?? fields.status);
  res.status(status).json({
    success: false,
    message: fallbackMessage || asText(fields.message) || '操作失败',
    error: {
      code: asText(fields.code) || 'AGENT_INTERNAL_ERROR',
      details: asDetails(fields.details),
      retryable: asRetryable(fields.retryable)
    },
    meta: responseMeta(req, meta)
  });
}

/**
 * 异步处理器包装 - 通过 next(error) 交给统一错误出口
 */
export function asyncHandler<Req extends ApiRequestLike = ApiRequestLike, Res extends ApiResponseWriter = ApiResponseWriter>(
  fn: (req: Req, res: Res, next: NextLike) => unknown
): (req: Req, res: Res, next: NextLike) => Promise<void> {
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
function normalizeErrorStatus(value: unknown): number {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

/**
 * 请求框架错误（body 解析等）到稳定 JSON 错误的映射
 */
interface RequestFrameworkErrorMapping {
  type: string;
  code: string;
  message: string;
  status: number;
}

const REQUEST_FRAMEWORK_ERRORS: readonly RequestFrameworkErrorMapping[] = [
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

function mapRequestFrameworkError(error: unknown): RequestFrameworkErrorMapping | null {
  const type = errorFieldsOf(error).type;
  return REQUEST_FRAMEWORK_ERRORS.find(mapping => type === mapping.type) || null;
}

/**
 * 路由参数解码失败（Express 对畸形百分号编码抛出带 400 状态的 URIError）
 */
function isPathParamDecodeError(error: unknown): boolean {
  return error instanceof URIError
    && (errorFieldsOf(error).status === 400 || errorFieldsOf(error).statusCode === 400);
}

function logApiError(req: MaybeApiRequest, status: number, code: string, message: string | null = null): void {
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
export function apiErrorHandler(error: unknown, req: MaybeApiRequest, res: ApiResponseWriter, next: NextLike): void {
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

  const fields = errorFieldsOf(error);
  const rawStatus = Number(fields.statusCode ?? fields.status);
  const declaredStatus = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : null;

  if (declaredStatus !== null) {
    logApiError(req, declaredStatus, asText(fields.code) || 'AGENT_INTERNAL_ERROR', asText(fields.message) || null);
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
export function validateRequired(data: Record<string, unknown>, requiredFields: readonly string[]): void {
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
 * 安全的 JSON 解析。返回值显式为 unknown，由调用方自行校验收窄，本函数不冒充校验。
 */
export function safeJsonParse(str: string, defaultValue: unknown = null): unknown {
  try {
    return JSON.parse(str);
  } catch (error) {
    console.error('JSON 解析失败:', error instanceof Error ? error.message : error);
    return defaultValue;
  }
}
