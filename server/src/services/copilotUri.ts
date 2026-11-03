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
