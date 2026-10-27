import { createOutboundHttpClient } from './outboundRequestService.ts'

// 悖论模拟数据回源读取（GitHub raw JSON）统一经出站端口：
// GET 读取按端口缺省受限重试，显式时限与错误映射由端口承担。
const outboundHttp = createOutboundHttpClient()

function normalizeStageIdForPrts(stageId = '') {
  return String(stageId).replace(/#[fn]#/g, '')
}

async function loadLocalJson(relativePath, fallback) {
  const fs = await import('fs/promises')
  const path = await import('path')
  const { fileURLToPath } = await import('url')
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)

  try {
    const filePath = path.join(__dirname, relativePath)
    return JSON.parse(await fs.readFile(filePath, 'utf-8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

export async function resolveStageSearchKeyword(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''

  const stages = await loadLocalJson('../data/stages.json', {})
  const upper = raw.toUpperCase()
  const stage = stages[upper]
    || Object.values(stages).find(item =>
      String(item.code || '').toUpperCase() === upper
      || String(item.name || '').trim() === raw
      || String(item.id || '').toUpperCase() === upper
    )

  return stage?.id ? normalizeStageIdForPrts(stage.id) : raw
}

export async function loadParadoxOperators() {
  const cached = await loadLocalJson('../data/paradox-operators.json', null)
  if (Array.isArray(cached)) return cached

  const [handbookResult, characterResult] = await Promise.all([
    outboundHttp.requestJson('https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/handbook_info_table.json'),
    outboundHttp.requestJson('https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/character_table.json')
  ])

  const handbook = handbookResult.data
  const characters = characterResult.data

  return Object.entries(handbook.handbookStageData || {})
    .map(([charId, stage]) => ({
      id: charId,
      name: characters[charId]?.name || handbook.handbookDict?.[charId]?.infoName || charId,
      stage_id: stage.stageId || stage.code,
      stage_name: stage.name || ''
    }))
    .filter(item => item.stage_id)
}
