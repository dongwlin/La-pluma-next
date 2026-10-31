import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createOutboundHttpClient } from './outboundRequestService.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 悖论模拟数据回源读取（GitHub raw JSON）统一经出站端口：
// GET 读取按端口缺省受限重试，显式时限与错误映射由端口承担。
const outboundHttp = createOutboundHttpClient()

const STAGES_PATH = join(__dirname, '../../data/stages.json')
const PARADOX_OPERATORS_PATH = join(__dirname, '../../data/paradox-operators.json')
const HANDBOOK_URL = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/handbook_info_table.json'
const CHARACTER_URL = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/character_table.json'

/** 关卡表条目：本服务只用 id/code/name 匹配关键字。 */
export interface StageRecord {
  id?: string;
  code?: string;
  name?: string;
}

/** 悖论模拟干员条目。 */
export interface ParadoxOperator {
  id: string;
  name: string;
  stage_id: string;
  stage_name: string;
}

/** 出站读取端口的最小返回结构。 */
export interface CopilotJsonResponse {
  data: unknown;
}

/** 本地数据路径与回源的覆盖入口；测试用临时文件与假端口，不触发真实下载。 */
export interface CopilotServicePorts {
  stagesPath?: string;
  paradoxOperatorsPath?: string;
  requestJson?: (url: string) => Promise<CopilotJsonResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

async function defaultRequestJson(url: string): Promise<CopilotJsonResponse> {
  const result = await outboundHttp.requestJson(url)
  return { data: result.data }
}

function normalizeStageIdForPrts(stageId = '') {
  return String(stageId).replace(/#[fn]#/g, '')
}

/** 读取本地 JSON；文件缺失时返回 fallback，其它读取/解析错误原样抛出。 */
async function loadLocalJson(filePath: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return fallback
    throw error
  }
}

/** 关卡表解析：保留可匹配字段，其它字段不透出。 */
export function parseStageTable(value: unknown): Record<string, StageRecord> {
  if (!isRecord(value)) return {}
  const stages: Record<string, StageRecord> = {}
  for (const [code, rawStage] of Object.entries(value)) {
    if (!isRecord(rawStage)) continue
    const stage: StageRecord = {}
    if (typeof rawStage.id === 'string') stage.id = rawStage.id
    if (typeof rawStage.code === 'string') stage.code = rawStage.code
    if (typeof rawStage.name === 'string') stage.name = rawStage.name
    stages[code] = stage
  }
  return stages
}

function parseParadoxOperator(value: unknown): ParadoxOperator | null {
  if (!isRecord(value)) return null
  const { id, name, stage_id: stageId, stage_name: stageName } = value
  if (typeof id !== 'string' || typeof stageId !== 'string' || !stageId) return null
  return {
    id,
    name: typeof name === 'string' ? name : id,
    stage_id: stageId,
    stage_name: typeof stageName === 'string' ? stageName : ''
  }
}

/** 已缓存的干员列表解析：结构不符的条目被忽略，不把整份缓存判坏。 */
export function parseParadoxOperatorList(value: unknown): ParadoxOperator[] {
  if (!Array.isArray(value)) return []
  const operators: ParadoxOperator[] = []
  for (const entry of value) {
    const operator = parseParadoxOperator(entry)
    if (operator) operators.push(operator)
  }
  return operators
}

/**
 * 从游戏数据表生成悖论模拟干员列表。
 * 上游载荷缺失对应段时按空表处理（与原实现的可选访问一致）。
 */
export function parseParadoxOperators(handbook: unknown, characters: unknown): ParadoxOperator[] {
  const handbookRecord = isRecord(handbook) ? handbook : {}
  const handbookStages = isRecord(handbookRecord.handbookStageData) ? handbookRecord.handbookStageData : {}
  const handbookDict = isRecord(handbookRecord.handbookDict) ? handbookRecord.handbookDict : {}
  const characterTable = isRecord(characters) ? characters : {}

  const operators: ParadoxOperator[] = []
  for (const [charId, rawStage] of Object.entries(handbookStages)) {
    if (!isRecord(rawStage)) continue
    const stageId = typeof rawStage.stageId === 'string' && rawStage.stageId
      ? rawStage.stageId
      : typeof rawStage.code === 'string' ? rawStage.code : ''
    if (!stageId) continue

    const character = characterTable[charId]
    const dictEntry = handbookDict[charId]
    const name = isRecord(character) && typeof character.name === 'string' && character.name
      ? character.name
      : isRecord(dictEntry) && typeof dictEntry.infoName === 'string' ? dictEntry.infoName : charId

    operators.push({
      id: charId,
      name,
      stage_id: stageId,
      stage_name: typeof rawStage.name === 'string' ? rawStage.name : ''
    })
  }
  return operators
}

/**
 * 把关卡输入解析为作业站可用的关键字：优先按关卡表解析 id，
 * 找不到时原样返回输入。关卡表缺失或结构不符时同样回退到原输入。
 */
export async function resolveStageSearchKeyword(
  input: unknown,
  ports: CopilotServicePorts = {}
): Promise<string> {
  const raw = String(input || '').trim()
  if (!raw) return ''

  const stages = parseStageTable(await loadLocalJson(ports.stagesPath || STAGES_PATH, {}))
  const upper = raw.toUpperCase()
  const direct = stages[upper]
  const stage: StageRecord | undefined = direct || Object.values(stages).find(item =>
    String(item.code || '').toUpperCase() === upper
    || String(item.name || '').trim() === raw
    || String(item.id || '').toUpperCase() === upper
  )

  return stage?.id ? normalizeStageIdForPrts(stage.id) : raw
}

/**
 * 读取悖论模拟干员列表：优先使用本地缓存，缺失时经出站端口回源。
 * 缓存文件为数组时按条目解析；缺失或非数组视为未缓存。
 */
export async function loadParadoxOperators(ports: CopilotServicePorts = {}): Promise<ParadoxOperator[]> {
  const cached = await loadLocalJson(ports.paradoxOperatorsPath || PARADOX_OPERATORS_PATH, null)
  if (Array.isArray(cached)) return parseParadoxOperatorList(cached)

  const requestJson = ports.requestJson || defaultRequestJson
  const [handbookResult, characterResult] = await Promise.all([
    requestJson(HANDBOOK_URL),
    requestJson(CHARACTER_URL)
  ])

  return parseParadoxOperators(handbookResult.data, characterResult.data)
}
