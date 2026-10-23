export function parseCopilotUri(uri: string): { id: string; isSet: boolean } | null {
  const current = uri.match(/^prts:\/\/(s?)(\d+)$/i)
  return current ? { id: current[2]!, isSet: Boolean(current[1]) } : null
}

export function normalizeCopilotUri(uri: string): string {
  const parsed = parseCopilotUri(uri)
  if (parsed) return `prts://${parsed.isSet ? 's' : ''}${parsed.id}`
  if (!/^https?:\/\//i.test(uri)) return uri

  try {
    const url = new URL(uri)
    const idMatch = `${url.pathname} ${url.search}`.match(/(\d+)(s?)(?!.*\d)/)
    const isSet = /set|collection|合集|作业集/i.test(url.pathname + url.search)
    if (idMatch) return `prts://${isSet || idMatch[2] === 's' ? 's' : ''}${idMatch[1]}`
  } catch {
    // 保留无法解析的输入，交给 maa-cli 报错。
  }
  return uri
}

export function normalizeCopilotInput(input: string): string {
  return input.split(/\n+/).map(line => line.trim()).filter(Boolean).map(normalizeCopilotUri).join(' ')
}

export function splitCopilotInputToArgs(input: string): string[] {
  return (input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
    .map(arg => arg.replace(/^("|')|("|')$/g, ''))
    .filter(Boolean)
    .map(normalizeCopilotUri)
}
