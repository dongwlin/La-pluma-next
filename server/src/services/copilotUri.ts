export interface CopilotUri {
  id: string;
  isSet: boolean;
}

/** `maa://` 是 maa-cli 已弃用的旧别名，解析后统一规范化为 `prts://`。 */
const COPILOT_URI_PATTERN = /^(?:prts|maa):\/\/(s?)(\d+)$/i;

export function parseCopilotUri(uri: unknown): CopilotUri | null {
  if (typeof uri !== 'string') return null;
  const current = uri.match(COPILOT_URI_PATTERN);
  return current ? { id: current[2], isSet: Boolean(current[1]) } : null;
}

export function normalizeCopilotUri(uri: string): string {
  const parsed = parseCopilotUri(uri);
  return parsed ? `prts://${parsed.isSet ? 's' : ''}${parsed.id}` : uri;
}

export function normalizeCopilotCommandArgs(command: string, args: string[]): string[] {
  return ['copilot', 'ssscopilot', 'paradoxcopilot'].includes(command)
    ? args.map(normalizeCopilotUri)
    : args;
}
