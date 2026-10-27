/**
 * 统一 HTTP 出站请求端口：带显式时限、取消与受限重试的出站调用底座。
 *
 * 三个显式端口：
 * - requestJson：JSON 请求体（自动序列化并补默认 Content-Type），响应按 JSON 解析；
 * - requestText：请求体原样透传，响应返回文本；
 * - requestMultipart：multipart 表单（原生 FormData 或 form-data 实例原样透传，
 *   不在本端口内构造编码），响应按 JSON 解析。
 *
 * 时限：timeoutMs 覆盖整次交换（连接、响应与响应体读取），每次尝试独立计时；
 * timeoutMs: null 表示不设时限（长轮询等由上游约定停留时长的调用），
 * 此时生命周期完全由调用方传入的 signal 控制；缺省时限 DEFAULT_OUTBOUND_TIMEOUT_MS，
 * 可用工厂 defaultTimeoutMs 按领域覆盖。
 *
 * 错误映射：所有失败抛出 OutboundRequestError，kind 区分
 * timeout / cancelled / network / http-error / invalid-response；
 * code/statusCode/details/retryable 字段与 apiHelper 统一错误信封兼容，
 * 可直接交给 errorResponse/sendError 出口。错误信息与 details 不包含请求 URL
 * （部分上游 URL 内嵌凭据），响应体片段截断保存用于上游诊断。
 *
 * 重试：仅安全读取（GET/HEAD）按有限次数重试瞬时失败
 * （网络错误、超时、408/429/502/503/504 状态），退避按 baseDelayMs 指数递增；
 * 执行/更新/通知等写入强制不自动重放，即使调用方显式传入 retry 配置也不生效；
 * 重试退避期间调用方 signal 取消会立即中止，不再发起后续尝试。
 */

/** 注入 fetch 的最小请求结构端口；body 保持 unknown 以兼容原生 FormData 与 form-data 实例。 */
export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/** 注入 fetch 的最小响应结构端口：只需状态字段与消费型 text() 读取。 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

/** 可注入替换的出站 fetch 端口；缺省绑定 Node 全局 fetch。 */
export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

/** 出站失败类别：显式时限、主动取消、网络失败、非成功 HTTP、成功状态的非法响应体。 */
export type OutboundRequestErrorKind =
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'http-error'
  | 'invalid-response';

/** 出站失败的结构化错误：code/statusCode/details/retryable 与统一错误信封兼容。 */
export interface OutboundRequestError extends Error {
  kind: OutboundRequestErrorKind;
  code: string;
  statusCode: number;
  details: Record<string, unknown>;
  retryable: boolean;
}

const KIND_CODES: Record<OutboundRequestErrorKind, string> = {
  'timeout': 'AGENT_OUTBOUND_TIMEOUT',
  'cancelled': 'AGENT_OUTBOUND_CANCELLED',
  'network': 'AGENT_OUTBOUND_NETWORK',
  'http-error': 'AGENT_OUTBOUND_HTTP_STATUS',
  'invalid-response': 'AGENT_OUTBOUND_RESPONSE_INVALID'
};

/** kind 到 HTTP 出口缺省状态的映射；http-error 由上游状态覆盖。 */
const KIND_STATUS_CODES: Record<OutboundRequestErrorKind, number> = {
  'timeout': 504,
  'cancelled': 499,
  'network': 502,
  'http-error': 502,
  'invalid-response': 502
};

/** 判断错误是否为出站请求端口产出的结构化失败。 */
export function isOutboundRequestError(error: unknown): error is OutboundRequestError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Partial<OutboundRequestError>;
  return typeof candidate.kind === 'string'
    && typeof candidate.code === 'string'
    && typeof candidate.statusCode === 'number'
    && typeof candidate.retryable === 'boolean';
}

function outboundError(
  kind: OutboundRequestErrorKind,
  message: string,
  details: Record<string, unknown> = {},
  overrides: { statusCode?: number; retryable?: boolean } = {}
): OutboundRequestError {
  return Object.assign(new Error(message), {
    kind,
    code: KIND_CODES[kind],
    statusCode: overrides.statusCode ?? KIND_STATUS_CODES[kind],
    details,
    retryable: overrides.retryable ?? false
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 缺省时限：单次尝试的整段交换上限（毫秒）。 */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000;

/** 缺省最大重试次数（不含首次尝试），仅安全读取生效。 */
export const DEFAULT_OUTBOUND_MAX_RETRIES = 2;

/** 缺省重试基础退避毫秒数，按 2 的指数递增。 */
export const DEFAULT_OUTBOUND_RETRY_DELAY_MS = 500;

/** 视为瞬时的上游状态：请求超时、限流与常见网关错误。 */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

/** 判断上游 HTTP 状态是否视为瞬时失败（仅影响安全读取的重试与 retryable 标记）。 */
export function isTransientOutboundStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUSES.has(status);
}

const SAFE_RETRY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

function isSafeMethod(method: string): boolean {
  return SAFE_RETRY_METHODS.has(method.toUpperCase());
}

/** 上游状态收窄到 400-599 作为本服务的 HTTP 出口状态，越界值按 502 处理。 */
function clampUpstreamStatusCode(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

const MAX_ERROR_BODY_SNIPPET_CHARS = 512;

function truncateBodySnippet(bodyText: string): string {
  return bodyText.length > MAX_ERROR_BODY_SNIPPET_CHARS
    ? `${bodyText.slice(0, MAX_ERROR_BODY_SNIPPET_CHARS)}…`
    : bodyText;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name);
}

/** 重试配置：maxRetries 为首次尝试之后的最多重试次数；仅安全读取生效。 */
export interface OutboundRequestRetryOptions {
  maxRetries?: number;
  /** 首次重试前的基础等待毫秒数，第 n 次重试前等待 baseDelayMs * 2^(n-1)。 */
  baseDelayMs?: number;
}

export interface OutboundRequestOptions {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** 调用方生命周期 signal：取消优先于时限，并中止后续重试。 */
  signal?: AbortSignal;
  /**
   * 显式时限（毫秒），覆盖整次交换；null 表示不设时限（长轮询）。
   * 缺省使用工厂 defaultTimeoutMs。
   */
  timeoutMs?: number | null;
  retry?: OutboundRequestRetryOptions;
  /**
   * 请求体含义随端口不同：
   * - requestText：原样透传给 fetch 的任意请求体；
   * - requestJson：JSON 可序列化载荷，端口负责序列化。
   * undefined 表示无请求体。
   */
  body?: unknown;
}

export interface OutboundMultipartRequestOptions extends Omit<OutboundRequestOptions, 'body'> {
  /**
   * multipart/form-data 请求体：原生 FormData 或 form-data 实例原样透传，
   * 本端口不构造编码；form-data 实例需由调用方自行传入 getHeaders()。
   */
  formData: unknown;
}

export interface OutboundTextResult {
  status: number;
  text: string;
}

/** 响应体未经运行时校验，data 由调用方自行收窄（与 safeJsonParse 契约一致）。 */
export interface OutboundJsonResult {
  status: number;
  data: unknown;
}

export interface OutboundHttpConfig {
  /** 可注入的出站 fetch；缺省绑定 Node 全局 fetch。 */
  fetch?: FetchLike;
  /** 缺省时限毫秒数；调用方 timeoutMs 覆盖。 */
  defaultTimeoutMs?: number;
  /** 安全读取的缺省最大重试次数。 */
  maxRetries?: number;
  /** 缺省重试基础退避毫秒数。 */
  baseRetryDelayMs?: number;
}

export interface OutboundHttpClient {
  requestJson(url: string, options?: OutboundRequestOptions): Promise<OutboundJsonResult>;
  requestText(url: string, options?: OutboundRequestOptions): Promise<OutboundTextResult>;
  requestMultipart(url: string, options: OutboundMultipartRequestOptions): Promise<OutboundJsonResult>;
}

interface FactoryDefaults {
  defaultTimeoutMs: number;
  defaultMaxRetries: number;
  defaultBaseDelayMs: number;
}

type OutboundResponseType = 'text' | 'json';

interface RequestPlan {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** undefined 表示无请求体。 */
  body: unknown;
  callerSignal: AbortSignal | undefined;
  /** null 表示不设时限。 */
  timeoutMs: number | null;
  maxRetries: number;
  baseDelayMs: number;
  responseType: OutboundResponseType;
}

/** 用法错误属于调用方程序缺陷，抛普通 TypeError，不混入出站失败类别。 */
function validateOutboundUsage(input: {
  url: string;
  method: string;
  timeoutMs: number | null;
  retry: OutboundRequestRetryOptions | undefined;
  hasBody: boolean;
  responseType: OutboundResponseType;
}): void {
  const { url, method, timeoutMs, retry, hasBody, responseType } = input;
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new TypeError('出站请求 URL 不能为空');
  }
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError('出站请求时限必须为正有限毫秒数或 null（null 表示不设时限）');
  }
  if (retry?.maxRetries !== undefined && (!Number.isInteger(retry.maxRetries) || retry.maxRetries < 0)) {
    throw new TypeError('出站请求重试次数必须为非负整数');
  }
  if (retry?.baseDelayMs !== undefined && (!Number.isFinite(retry.baseDelayMs) || retry.baseDelayMs < 0)) {
    throw new TypeError('出站请求重试退避毫秒数必须为非负有限数');
  }
  if (hasBody && isSafeMethod(method)) {
    throw new TypeError(`安全读取方法 ${method} 不接受请求体`);
  }
  if (responseType === 'json' && method === 'HEAD') {
    throw new TypeError('JSON 端口不适用于 HEAD 请求');
  }
}

function buildPlan<T extends OutboundResponseType>(
  responseType: T,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: unknown,
  options: OutboundRequestOptions,
  defaults: FactoryDefaults
): RequestPlan & { responseType: T } {
  const timeoutMs = options.timeoutMs === undefined ? defaults.defaultTimeoutMs : options.timeoutMs;
  validateOutboundUsage({
    url,
    method,
    timeoutMs,
    retry: options.retry,
    hasBody: body !== undefined,
    responseType
  });
  return {
    url,
    method,
    headers,
    body,
    callerSignal: options.signal,
    timeoutMs,
    // 写入强制不自动重放：即使调用方显式传入 retry 配置，非安全读取的重试次数也为 0。
    maxRetries: isSafeMethod(method) ? (options.retry?.maxRetries ?? defaults.defaultMaxRetries) : 0,
    baseDelayMs: options.retry?.baseDelayMs ?? defaults.defaultBaseDelayMs,
    responseType
  };
}

function cancelledError(signal: AbortSignal | undefined): OutboundRequestError {
  const reason = signal?.reason;
  return outboundError('cancelled', '出站请求已被取消', {
    reason: reason instanceof Error ? reason.message : reason === undefined ? null : String(reason)
  });
}

function classifyExchangeFailure(cause: unknown, plan: RequestPlan, timedOut: boolean): OutboundRequestError {
  // 取消优先于超时报告：调用方已放弃本次调用时，结果不再有意义。
  if (plan.callerSignal?.aborted) {
    return cancelledError(plan.callerSignal);
  }
  if (timedOut) {
    return outboundError('timeout', '出站请求超出显式时限', { timeoutMs: plan.timeoutMs }, {
      retryable: isSafeMethod(plan.method)
    });
  }
  return outboundError('network', `出站请求网络失败: ${errorMessage(cause)}`, {
    cause: errorMessage(cause)
  }, { retryable: isSafeMethod(plan.method) });
}

/**
 * 等待退避时长；调用方 signal 取消时立即返回 true，调用方据此中止重试。
 */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  if (ms <= 0) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = (aborted: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(aborted);
    };
    const onAbort = () => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function performAttempt(plan: RequestPlan, fetchImpl: FetchLike): Promise<OutboundTextResult | OutboundJsonResult> {
  const controller = new AbortController();
  const callerSignal = plan.callerSignal;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forwardCallerAbort: (() => void) | undefined;
  try {
    if (plan.timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('出站请求超出显式时限', 'TimeoutError'));
      }, plan.timeoutMs);
    }
    if (callerSignal) {
      forwardCallerAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener('abort', forwardCallerAbort, { once: true });
    }

    let response: FetchResponseLike;
    try {
      response = await fetchImpl(plan.url, {
        method: plan.method,
        headers: plan.headers,
        body: plan.body,
        signal: controller.signal
      });
    } catch (cause) {
      throw classifyExchangeFailure(cause, plan, timedOut);
    }

    // 响应头已接收；时限继续覆盖响应体读取，超时与取消仍能中断慢响应体。
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (cause) {
      throw classifyExchangeFailure(cause, plan, timedOut);
    }

    if (!response.ok) {
      throw outboundError('http-error', `上游返回非成功状态 ${response.status}`, {
        status: response.status,
        statusText: response.statusText,
        body: bodyText ? truncateBodySnippet(bodyText) : null
      }, {
        statusCode: clampUpstreamStatusCode(response.status),
        retryable: isSafeMethod(plan.method) && isTransientOutboundStatus(response.status)
      });
    }

    if (plan.responseType === 'text') {
      return { status: response.status, text: bodyText };
    }

    let data: unknown;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw outboundError('invalid-response', '上游响应体不是有效的 JSON', {
        status: response.status,
        body: truncateBodySnippet(bodyText)
      });
    }
    return { status: response.status, data };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (forwardCallerAbort && callerSignal) {
      callerSignal.removeEventListener('abort', forwardCallerAbort);
    }
  }
}

function ensureOutboundError(error: unknown, plan: RequestPlan): OutboundRequestError {
  if (isOutboundRequestError(error)) return error;
  return outboundError('network', `出站请求网络失败: ${errorMessage(error)}`, {
    cause: errorMessage(error)
  }, { retryable: isSafeMethod(plan.method) });
}

async function executeRequest(plan: RequestPlan & { responseType: 'text' }, fetchImpl: FetchLike): Promise<OutboundTextResult>;
async function executeRequest(plan: RequestPlan & { responseType: 'json' }, fetchImpl: FetchLike): Promise<OutboundJsonResult>;
async function executeRequest(plan: RequestPlan, fetchImpl: FetchLike): Promise<OutboundTextResult | OutboundJsonResult> {
  let attempt = 0;
  for (;;) {
    if (plan.callerSignal?.aborted) {
      throw cancelledError(plan.callerSignal);
    }
    let failure: OutboundRequestError;
    try {
      return await performAttempt(plan, fetchImpl);
    } catch (error) {
      failure = ensureOutboundError(error, plan);
    }
    if (attempt >= plan.maxRetries || !failure.retryable) {
      throw failure;
    }
    const aborted = await abortableDelay(plan.baseDelayMs * 2 ** attempt, plan.callerSignal);
    if (aborted || plan.callerSignal?.aborted) {
      throw cancelledError(plan.callerSignal);
    }
    attempt += 1;
  }
}

/**
 * Node 全局 fetch 到结构端口的唯一边界适配：
 * body 的具体形态（字符串、原生 FormData、form-data 实例等）由调用方保证可被 fetch 接受。
 */
const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, {
  method: init?.method,
  headers: init?.headers,
  body: init?.body as RequestInit['body'],
  signal: init?.signal
});

/**
 * 创建独立出站请求客户端实例：fetch 与时限/重试缺省值均可注入，
 * 实例之间不共享可变状态。领域服务应通过工厂持有自己的实例，
 * 便于测试注入与按领域覆盖超时配置。
 */
export function createOutboundHttpClient(config: OutboundHttpConfig = {}): OutboundHttpClient {
  const fetchImpl = config.fetch ?? defaultFetch;
  const defaults: FactoryDefaults = {
    defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS,
    defaultMaxRetries: config.maxRetries ?? DEFAULT_OUTBOUND_MAX_RETRIES,
    defaultBaseDelayMs: config.baseRetryDelayMs ?? DEFAULT_OUTBOUND_RETRY_DELAY_MS
  };

  return {
    requestJson: async (url, options = {}) => {
      const method = (options.method ?? 'GET').toUpperCase();
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      const headers = { ...(options.headers ?? {}) };
      if (body !== undefined && !hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
      return executeRequest(buildPlan('json', url, method, headers, body, options, defaults), fetchImpl);
    },
    requestText: async (url, options = {}) => {
      const method = (options.method ?? 'GET').toUpperCase();
      return executeRequest(
        buildPlan('text', url, method, { ...(options.headers ?? {}) }, options.body, options, defaults),
        fetchImpl
      );
    },
    requestMultipart: async (url, options) => {
      if (options.formData === undefined) {
        throw new TypeError('multipart 端口需要提供 formData');
      }
      const method = (options.method ?? 'POST').toUpperCase();
      return executeRequest(
        buildPlan('json', url, method, { ...(options.headers ?? {}) }, options.formData, options, defaults),
        fetchImpl
      );
    }
  };
}

/** 缺省出站客户端：绑定 Node 全局 fetch 与缺省时限/重试配置。 */
export const outboundHttpClient: OutboundHttpClient = createOutboundHttpClient();
