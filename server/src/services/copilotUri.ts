export interface CopilotUri {
  id: string;
  isSet: boolean;
}

export function parseCopilotUri(uri: unknown): CopilotUri | null {
  if (typeof uri !== 'string') return null;
  const current = uri.match(/^prts:\/\/(s?)(\d+)$/i);
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
