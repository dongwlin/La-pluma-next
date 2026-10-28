/**
 * 作业站 URI 的解析与归一化。
 *
 * 只识别作业站协议 `prts://<数字>` 与作业集 `prts://s<数字>`；本地文件、
 * 命令行参数和其他协议原样返回。解析边界接收 unknown，调用方传来的文本、
 * 配置值都先按字符串收窄，再交给正则判断。
 */

/** prts:// 作业 URI 的解析结果：id 为数字代号，isSet 表示作业集。 */
export interface CopilotUri {
  id: string;
  isSet: boolean;
}

/** 解析作业站 URI；非字符串或非作业站协议返回 null。 */
export function parseCopilotUri(uri: unknown): CopilotUri | null {
  if (typeof uri !== 'string') return null;
  const current = uri.match(/^prts:\/\/(s?)(\d+)$/i);
  return current ? { id: current[2], isSet: Boolean(current[1]) } : null;
}

/** 把可识别的作业站 URI 归一化为小写协议与集前缀；其他输入原样返回。 */
export function normalizeCopilotUri(uri: string): string {
  const parsed = parseCopilotUri(uri);
  return parsed ? `prts://${parsed.isSet ? 's' : ''}${parsed.id}` : uri;
}

/** copilot/ssscopilot/paradoxcopilot 参数中的作业 URI 归一化，其他命令原样返回同一数组。 */
export function normalizeCopilotCommandArgs(command: string, args: string[]): string[] {
  return ['copilot', 'ssscopilot', 'paradoxcopilot'].includes(command)
    ? args.map(normalizeCopilotUri)
    : args;
}
