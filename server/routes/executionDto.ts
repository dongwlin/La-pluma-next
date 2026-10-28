/**
 * 执行 HTTP DTO
 *
 * 把 Express 请求中的未知输入收窄成执行适配需要的类型；router 只做 HTTP
 * 适配，Run 身份、幂等与设备租约仍由 agentRunService /
 * executionCoordinatorService 持有，接受后的终态由实际执行结果收尾。
 *
 * 请求侧按端点分别收窄：
 * - `Idempotency-Key` 头保持原值透传，键格式与合法性仍由 agentRunService
 *   的既有校验判定，不在适配层复制第二份规则；
 * - `waitForCompletion` 只接受布尔值，其它类型保留既有 400 文案与
 *   `receivedType` 详情；
 * - 目标停止与继续下一关的 `runId` 只接受非空字符串，缺失/非字符串按
 *   既有错误码拒绝；
 * - 响应载荷沿用 Run DTO 与执行结果字段，`result` 合并字段保持开放，
 *   不在这里补造或改写领域结果。
 */

import type { AgentRunDto, AgentRunStatus } from '../services/agentRunService.ts';
import type { ApiRequestLike, ApiResponseWriter } from '../utils/apiHelper.ts';
import { agentError } from '../utils/apiHelper.ts';

/** 执行路由处理器的请求端口：body/query 保持 unknown，由本模块按端点收窄。 */
export interface ExecutionRequest extends ApiRequestLike {
  body?: unknown;
  query?: unknown;
  get?(name: string): string | undefined;
  params?: Record<string, string | undefined>;
}

/** 作业集执行/继续路由：`:id` 由路由声明收窄为 string。 */
export interface ExecutionCopilotSetRequest extends ExecutionRequest {
  params: { id: string };
}

/** 定时流程执行路由：`:scheduleId` 由路由声明收窄为 string。 */
export interface ExecutionScheduleRequest extends ExecutionRequest {
  params: { scheduleId: string };
}

/** 执行响应写入端口：除统一 JSON/状态写入外还需要 Run 响应头。 */
export interface ExecutionResponseWriter extends ApiResponseWriter {
  set?(name: string, value: string): unknown;
  setHeader?(name: string, value: string): unknown;
}

/** 执行响应数据：Run 标识与轮询链接固定字段，领域结果字段保持开放。 */
export interface ExecutionRunPayload extends Record<string, unknown> {
  runId: string;
  state: AgentRunStatus;
  pollUrl: string;
  stopUrl: string;
  run: AgentRunDto;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取对象字段；非对象输入按缺失处理，与旧实现的属性访问结果一致。 */
export function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** 领域结果上的公开 message：非字符串按缺失处理，由调用方使用兜底文案。 */
export function resultMessage(result: unknown): string | null {
  const message = readField(result, 'message');
  return typeof message === 'string' ? message : null;
}

/** 旧实现的模板字符串按文本输出未知值，保留同一归一。 */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/** 执行结果是否被终止；只读取对象的布尔标记，非对象按未终止处理。 */
export function isStopped(value: unknown): boolean {
  return readField(value, 'stopped') === true;
}

/**
 * `Idempotency-Key` 头保持原值：HTTP 层提供字符串，其它形状（直接调用、
 * 异常头值）交给 agentRunService 的既有格式校验拒绝，不在适配层丢弃。
 */
export function readIdempotencyKey(req: ExecutionRequest): unknown {
  return req.get?.('Idempotency-Key')
    ?? req.headers?.['idempotency-key']
    ?? req.headers?.['Idempotency-Key']
    ?? null;
}

export function parseWaitForCompletion(value: unknown, defaultValue = true): boolean {
  const normalized = value ?? defaultValue;
  if (typeof normalized !== 'boolean') {
    throw agentError('AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID', 'waitForCompletion 必须是布尔值', {
      statusCode: 400,
      details: { receivedType: typeof normalized },
      retryable: false
    });
  }
  return normalized;
}

function parseRunId(requested: unknown): string {
  if (typeof requested !== 'string' || !requested.trim()) {
    throw agentError('AGENT_VALIDATION_RUN_ID_INVALID', 'runId 必须是非空字符串', {
      statusCode: 400,
      details: { receivedType: typeof requested },
      retryable: false
    });
  }
  return requested.trim();
}

/** 继续下一关：只读取请求体中的 `runId`。 */
export function parseContinueRunId(body: unknown): string {
  return parseRunId(readField(body, 'runId'));
}

/** 目标停止：请求体优先、查询参数回退；两者都缺失表示停止当前执行。 */
export function parseRequestedRunId(body: unknown, query: unknown): string | null {
  const requested = readField(body, 'runId') ?? readField(query, 'runId') ?? null;
  if (requested === null) return null;
  return parseRunId(requested);
}
