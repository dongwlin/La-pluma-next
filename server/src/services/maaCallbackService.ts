/**
 * MaaCore 回调解析
 *
 * 类型边界：
 * - 日志行与 JSON 载荷按 `unknown` 读取：只有对象载荷、且 `taskchain` 为字符串并与目标值一致时
 *   才产生事件；断行、非法 JSON、非对象载荷与其它 taskchain 一律跳过（增量日志检查点可能以半行开始）。
 * - 载荷字段（`what`、`class`、`details` 等）按 MaaCore 原样保留，调用方通过下方读取函数逐字段收窄，
 *   不把未校验的值当作已确认结构；未知字段不会因解析被丢弃。
 * - `callback` 取 JSON 之前的回调名；载荷里若有同名字段，以日志中的回调名为准（既有行为）。
 */

const CALLBACK_MARKER = 'Assistant::append_callback | ';

/** MaaCore 回调 `details` 载荷：字段由 taskchain 决定，统一按未知值交给调用方收窄。 */
export type MaaCallbackDetails = Readonly<Record<string, unknown>>;

/**
 * 单条 MaaCore 回调事件：`callback` 与 `taskchain` 已校验，其余字段按 MaaCore 原样保留，
 * 未建模字段不会因解析被丢弃。
 */
export interface MaaCallbackEvent {
  /** 回调类型，例如 `SubTaskStart`、`TaskChainCompleted`。 */
  callback: string;
  /** 回调所属 taskchain，等于调用方要求的值。 */
  taskchain: string;
  [field: string]: unknown;
}

function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析日志中的结构化回调：只保留目标 taskchain，容忍断行与非法 JSON。 */
export function parseMaaCallbackEvents(
  logOutput: string | null | undefined,
  taskchain: string
): MaaCallbackEvent[] {
  const events: MaaCallbackEvent[] = [];

  for (const line of String(logOutput || '').split('\n')) {
    const markerIndex = line.indexOf(CALLBACK_MARKER);
    if (markerIndex === -1) continue;

    const callback = line.slice(markerIndex + CALLBACK_MARKER.length);
    const jsonIndex = callback.indexOf('{');
    if (jsonIndex === -1) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(callback.slice(jsonIndex));
    } catch {
      // Incremental log checkpoints can begin with an incomplete callback line.
      continue;
    }

    // 只接受带目标 taskchain 的对象载荷；数组、标量与缺少 taskchain 的载荷都不是回调事件。
    if (!isPayloadRecord(payload)) continue;
    const payloadTaskchain = payload.taskchain;
    if (typeof payloadTaskchain !== 'string' || payloadTaskchain !== taskchain) continue;

    events.push({
      ...payload,
      taskchain: payloadTaskchain,
      callback: callback.slice(0, jsonIndex).trim()
    });
  }

  return events;
}

/** 读取回调载荷的对象 `details`；缺失或结构不符（数组/标量）时返回 undefined。 */
export function getCallbackDetails(event: MaaCallbackEvent): MaaCallbackDetails | undefined {
  const details = event.details;
  return isPayloadRecord(details) ? details : undefined;
}

/** 读取回调顶层的字符串字段（`what`、`class` 等）；缺失或非字符串时返回 undefined。 */
export function getCallbackStringField(event: MaaCallbackEvent, field: string): string | undefined {
  const value = event[field];
  return typeof value === 'string' ? value : undefined;
}

/** 读取 `details` 里的字符串数组字段（如 `tags`）；非数组返回空数组，非字符串项被忽略。 */
export function getCallbackStringList(event: MaaCallbackEvent, field: string): string[] {
  const value = getCallbackDetails(event)?.[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 读取 `details.task` 子任务名；缺失或非字符串时返回 undefined。 */
export function getCallbackTaskName(event: MaaCallbackEvent): string | undefined {
  const task = getCallbackDetails(event)?.task;
  return typeof task === 'string' ? task : undefined;
}

/** 汇总 `SubTaskStart` 回调的子任务名；缺少任务名的事件被跳过。 */
export function getStartedTaskNames(events: readonly MaaCallbackEvent[]): string[] {
  const taskNames: string[] = [];

  for (const event of events) {
    if (event.callback !== 'SubTaskStart') continue;
    const task = getCallbackTaskName(event);
    if (task !== undefined) taskNames.push(task);
  }

  return taskNames;
}
