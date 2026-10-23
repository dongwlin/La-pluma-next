export function parseCopilotUri(uri) {
  const current = uri.match(/^prts:\/\/(s?)(\d+)$/i);
  if (current) return { id: current[2], isSet: Boolean(current[1]) };

  const legacy = uri.match(/^maa:\/\/(\d+)(s?)$/i);
  return legacy ? { id: legacy[1], isSet: Boolean(legacy[2]) } : null;
}

export function normalizeCopilotUri(uri) {
  const parsed = parseCopilotUri(uri);
  return parsed ? `prts://${parsed.isSet ? 's' : ''}${parsed.id}` : uri;
}

export function normalizeCopilotCommandArgs(command, args) {
  return ['copilot', 'ssscopilot', 'paradoxcopilot'].includes(command)
    ? args.map(normalizeCopilotUri)
    : args;
}
