import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readJsonFile, writeJsonFile, ensureDir } from '../utils/fileHelper.ts';
import { successResponse, errorResponse, safeJsonParse } from '../utils/apiHelper.ts';
import type { ApiErrorResponse, ApiSuccessResponse } from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts';
import {
  getMaaLogPath,
  getItemIndexPath,
  getItemTablePath,
  getBattleDataPath
} from '../config/paths.ts';
import { createOutboundHttpClient } from './outboundRequestService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const logger = createLogger('DataParser');

// 物品表网络回源（GitHub raw JSON）统一经出站端口：显式时限与受限读取重试由端口承担。
const outboundHttp = createOutboundHttpClient();

const ITEM_TABLE_URL = 'https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/gamedata/excel/item_table.json';

// 项目数据目录（仓库缓存 depot.json / operbox.json）
const DATA_DIR = join(__dirname, '..', 'data');

/** 物品索引中的单个物品；字段不符的条目按缺失处理。 */
export interface ItemIndexEntry {
  name: string;
  icon: string | null;
  classifyType: string;
  sortId: number;
}

/** 游戏物品表中本服务读取的字段。 */
export interface ItemTableEntry {
  iconId?: string;
}

/** getItemInfo 的返回值；未知物品没有 iconId。 */
export interface GameItemInfo {
  id: string;
  name: string;
  icon: string | null;
  iconId?: string;
  classifyType: string;
  sortId: number;
}

/** 仓库缓存中的一个物品。 */
export interface DepotItem {
  id: string;
  name: string;
  count: number;
  icon: string | null;
  iconId?: string;
  classifyType: string;
  sortId: number;
}

/** server/data/depot.json 的结构。 */
export interface DepotFile {
  timestamp: string;
  itemCount: number;
  items: DepotItem[];
}

/**
 * server/data/operbox.json 的结构。条目本身是 MAA 识别结果，本服务只校验
 * 信封与数组形态，不解释干员字段，原样保存与返回。
 */
export interface OperBoxFile {
  timestamp: string;
  operCount: number;
  data: Record<string, unknown>[];
}

/** getAllOperators 返回的干员摘要。 */
export interface OperatorSummary {
  id: string;
  name: string;
  rarity: number;
  profession?: string;
  position?: string;
}

/** 仓库识别动作的响应载荷。 */
export interface DepotRecognitionResult {
  path: string;
  itemCount: number;
  items: DepotItem[];
}

/** 干员识别动作的响应载荷。 */
export interface OperBoxRecognitionResult {
  path: string;
  operCount: number;
  data: Record<string, unknown>[];
}

/**
 * 路径与回源端口。缺省绑定 MAA 资源路径与共享出站端口；
 * 测试用临时目录和假回源验证本地/网络分支，不触发真实下载。
 */
export interface DataParserPorts {
  itemIndexPath?: string;
  itemTablePath?: string;
  battleDataPath?: string;
  maaLogPath?: string;
  dataDir?: string;
  fetchItemTable?: () => Promise<unknown>;
}

interface DataParserContext {
  itemIndexPath: string;
  itemTablePath: string;
  battleDataPath: string;
  maaLogPath: string;
  dataDir: string;
  fetchItemTable: () => Promise<unknown>;
}

// 物品索引/物品表缓存按文件路径保存：同一进程内不同路径互不复用，
// 生产环境路径固定，行为与单一缓存一致。
interface PathCache<T> {
  path: string;
  value: T;
}

let itemIndexCache: PathCache<Record<string, ItemIndexEntry>> | null = null;
let itemTableCache: PathCache<Record<string, ItemTableEntry>> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createContext(ports: DataParserPorts): DataParserContext {
  return {
    itemIndexPath: ports.itemIndexPath || getItemIndexPath(),
    itemTablePath: ports.itemTablePath || getItemTablePath(),
    battleDataPath: ports.battleDataPath || getBattleDataPath(),
    maaLogPath: ports.maaLogPath || getMaaLogPath(),
    dataDir: ports.dataDir || DATA_DIR,
    fetchItemTable: ports.fetchItemTable || fetchItemTableFromNetwork
  };
}

async function fetchItemTableFromNetwork(): Promise<unknown> {
  const { data } = await outboundHttp.requestJson(ITEM_TABLE_URL);
  return data;
}

/** 物品索引解析：缺少字符串 name 的条目视为不可用，其余字段补齐缺省值。 */
export function parseItemIndex(value: unknown): Record<string, ItemIndexEntry> {
  if (!isRecord(value)) return {};
  const index: Record<string, ItemIndexEntry> = {};
  for (const [itemId, rawEntry] of Object.entries(value)) {
    if (!isRecord(rawEntry) || typeof rawEntry.name !== 'string') continue;
    index[itemId] = {
      name: rawEntry.name,
      icon: typeof rawEntry.icon === 'string' ? rawEntry.icon : null,
      classifyType: typeof rawEntry.classifyType === 'string' ? rawEntry.classifyType : 'UNKNOWN',
      sortId: typeof rawEntry.sortId === 'number' && Number.isFinite(rawEntry.sortId)
        ? rawEntry.sortId
        : 999999
    };
  }
  return index;
}

/** 物品表解析：只读取 items 映射中的 iconId，其它字段不参与本服务逻辑。 */
export function parseItemTable(value: unknown): Record<string, ItemTableEntry> {
  if (!isRecord(value) || !isRecord(value.items)) return {};
  const items: Record<string, ItemTableEntry> = {};
  for (const [itemId, rawEntry] of Object.entries(value.items)) {
    if (!isRecord(rawEntry)) continue;
    const entry: ItemTableEntry = {};
    if (typeof rawEntry.iconId === 'string') entry.iconId = rawEntry.iconId;
    items[itemId] = entry;
  }
  return items;
}

/**
 * 加载物品索引
 */
async function loadItemIndex(context: DataParserContext): Promise<Record<string, ItemIndexEntry>> {
  if (itemIndexCache && itemIndexCache.path === context.itemIndexPath) {
    return itemIndexCache.value;
  }

  try {
    const rawIndex = await readJsonFile(context.itemIndexPath, {});
    const itemIndex = parseItemIndex(rawIndex);
    itemIndexCache = { path: context.itemIndexPath, value: itemIndex };
    logger.info(`物品索引加载成功，共 ${Object.keys(itemIndex).length} 种物品`);
    return itemIndex;
  } catch (error) {
    logger.error('物品索引加载失败', { error: errorMessage(error) });
    return {};
  }
}

/**
 * 加载游戏物品表（包含 iconId）
 */
async function loadItemTable(context: DataParserContext): Promise<Record<string, ItemTableEntry>> {
  if (itemTableCache && itemTableCache.path === context.itemTablePath) {
    return itemTableCache.value;
  }

  try {
    // 尝试从本地加载；文件存在即视为本地命中，格式不符时按空表处理而不回源。
    const localData = await readJsonFile(context.itemTablePath, null);
    if (localData) {
      const items = parseItemTable(localData);
      itemTableCache = { path: context.itemTablePath, value: items };
      logger.info(`物品表从本地加载成功，共 ${Object.keys(items).length} 种物品`);
      return items;
    }

    // 从网络获取
    logger.info('本地文件不存在，尝试从网络获取物品表...');
    const data = await context.fetchItemTable();

    const items = parseItemTable(data);
    itemTableCache = { path: context.itemTablePath, value: items };
    logger.success(`物品表从网络加载成功，共 ${Object.keys(items).length} 种物品`);

    // 保存到本地
    await ensureDir(dirname(context.itemTablePath));
    await writeJsonFile(context.itemTablePath, data);
    logger.info('物品表已缓存到本地');

    return items;
  } catch (error) {
    logger.error('物品表加载失败', { error: errorMessage(error) });
    return {};
  }
}

/**
 * 根据物品 ID 获取物品信息
 */
async function getItemInfo(itemId: string, context: DataParserContext): Promise<GameItemInfo> {
  const itemIndex = await loadItemIndex(context);
  const itemTable = await loadItemTable(context);
  const item = itemIndex[itemId];
  const gameItem = itemTable[itemId];

  if (item) {
    return {
      id: itemId,
      name: item.name,
      icon: item.icon,
      iconId: gameItem?.iconId || itemId, // 使用游戏数据的 iconId，如果没有则使用 itemId
      classifyType: item.classifyType,
      sortId: item.sortId
    };
  }

  return {
    id: itemId,
    name: `未知物品 (${itemId})`,
    icon: null,
    classifyType: 'UNKNOWN',
    sortId: 999999
  };
}

/** DepotInfo 载荷解析：物品数量必须是有限数值，否则整份识别结果不可信。 */
export function parseDepotCounts(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const counts: Record<string, number> = {};
  for (const [itemId, count] of Object.entries(value)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) return null;
    counts[itemId] = count;
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

/** 已保存仓库缓存的解析；结构不符返回 null，由调用方按缺失处理。 */
export function parseDepotFile(value: unknown): DepotFile | null {
  if (!isRecord(value) || typeof value.timestamp !== 'string') return null;
  if (typeof value.itemCount !== 'number' || !Number.isFinite(value.itemCount)) return null;
  if (!Array.isArray(value.items)) return null;

  const items: DepotItem[] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem) || typeof rawItem.id !== 'string' || typeof rawItem.name !== 'string') return null;
    if (typeof rawItem.count !== 'number' || !Number.isFinite(rawItem.count)) return null;
    if (typeof rawItem.classifyType !== 'string') return null;
    if (typeof rawItem.sortId !== 'number' || !Number.isFinite(rawItem.sortId)) return null;
    const item: DepotItem = {
      id: rawItem.id,
      name: rawItem.name,
      count: rawItem.count,
      icon: typeof rawItem.icon === 'string' ? rawItem.icon : null,
      classifyType: rawItem.classifyType,
      sortId: rawItem.sortId
    };
    if (typeof rawItem.iconId === 'string') item.iconId = rawItem.iconId;
    items.push(item);
  }

  return { timestamp: value.timestamp, itemCount: value.itemCount, items };
}

/** 已保存干员缓存的解析；条目原样保留，只校验信封与数组形态。 */
export function parseOperBoxFile(value: unknown): OperBoxFile | null {
  if (!isRecord(value) || typeof value.timestamp !== 'string') return null;
  if (typeof value.operCount !== 'number' || !Number.isFinite(value.operCount)) return null;
  if (!Array.isArray(value.data)) return null;

  const data: Record<string, unknown>[] = [];
  for (const entry of value.data) {
    if (!isRecord(entry)) return null;
    data.push(entry);
  }

  return { timestamp: value.timestamp, operCount: value.operCount, data };
}

/** MAA 日志中的 OperBoxInfo 载荷解析；own_opers 缺失按空列表处理。 */
export function parseOperBoxOperators(details: unknown): Record<string, unknown>[] | null {
  if (!isRecord(details)) return null;
  const own = details.own_opers;
  if (own === undefined) return [];
  if (!Array.isArray(own)) return null;

  const operators: Record<string, unknown>[] = [];
  for (const entry of own) {
    if (!isRecord(entry)) return null;
    operators.push(entry);
  }
  return operators;
}

// 辅助函数：查找完成的 DepotInfo 数据
function findCompletedDepotData(logContent: string, depotMatches: RegExpMatchArray[]): string | null {
  for (let i = depotMatches.length - 1; i >= 0; i--) {
    const match = depotMatches[i];
    const contextStart = match.index ?? 0;
    const contextEnd = Math.min(contextStart + 5000, logContent.length);
    const context = logContent.substring(contextStart, contextEnd);

    if (context.includes('"done":true')) {
      return match[1];
    }
  }
  return null;
}

// 辅助函数：丰富仓库数据（添加物品信息）
async function enrichDepotData(
  depotData: Record<string, number>,
  context: DataParserContext
): Promise<Record<string, DepotItem>> {
  const enrichedData: Record<string, DepotItem> = {};

  for (const [itemId, count] of Object.entries(depotData)) {
    const itemInfo = await getItemInfo(itemId, context);
    const item: DepotItem = {
      id: itemId,
      name: itemInfo.name,
      count,
      icon: itemInfo.icon,
      classifyType: itemInfo.classifyType,
      sortId: itemInfo.sortId
    };
    if (itemInfo.iconId !== undefined) item.iconId = itemInfo.iconId;
    enrichedData[itemId] = item;
  }

  return enrichedData;
}

/**
 * 解析 MAA 日志文件，提取 DepotInfo 数据
 */
export async function parseDepotData(
  ports: DataParserPorts = {}
): Promise<ApiSuccessResponse<DepotRecognitionResult> | ApiErrorResponse | null> {
  try {
    const context = createContext(ports);
    const logPath = context.maaLogPath;
    logger.info('开始解析仓库数据', { logPath });

    let logContent = await readFile(logPath, 'utf-8');

    // 移除日志中的换行符（MAA 日志可能在单词中间换行）
    logContent = logContent.replace(/([a-zA-Z])\n([a-z])/g, '$1$2');

    // 查找最后一次 DepotInfo 数据
    const depotMatches = [...logContent.matchAll(/"what"\s*:\s*"DepotInfo"[\s\S]*?"details"\s*:\s*\{[\s\S]*?"data"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];

    if (depotMatches.length === 0) {
      logger.warn('未找到 DepotInfo 数据');
      return null;
    }

    // 取最后一次识别结果（done:true 的那个）
    let dataStr = findCompletedDepotData(logContent, depotMatches);

    if (!dataStr) {
      dataStr = depotMatches[depotMatches.length - 1][1];
      logger.info('使用最后一次 DepotInfo 数据');
    }

    logger.debug('数据字符串长度', { length: dataStr.length });

    // 解析数据
    const unescapedStr = dataStr.replace(/\\"/g, '"');
    const depotCounts = parseDepotCounts(safeJsonParse(unescapedStr, null));

    if (!depotCounts) {
      throw new Error('解析仓库数据失败');
    }

    logger.success(`解析成功，物品数量: ${Object.keys(depotCounts).length}`);

    // 加载物品索引，添加物品名称
    const enrichedData = await enrichDepotData(depotCounts, context);

    // 按 sortId 排序
    const sortedData = Object.values(enrichedData).sort((a, b) => a.sortId - b.sortId);

    // 保存到文件
    await ensureDir(context.dataDir);
    const outputPath = join(context.dataDir, 'depot.json');

    const output: DepotFile = {
      timestamp: new Date().toISOString(),
      itemCount: Object.keys(depotCounts).length,
      items: sortedData
    };

    await writeJsonFile(outputPath, output);
    logger.success('仓库数据已保存', { path: outputPath });

    return successResponse({
      path: outputPath,
      itemCount: Object.keys(depotCounts).length,
      items: sortedData
    });
  } catch (error) {
    logger.error('解析仓库数据失败', { error: errorMessage(error), stack: error instanceof Error ? error.stack : undefined });
    return errorResponse(error, '解析仓库数据失败');
  }
}

/**
 * 解析 MAA 日志文件，提取 OperBoxInfo 数据
 */
export async function parseOperBoxData(
  ports: DataParserPorts = {}
): Promise<ApiSuccessResponse<OperBoxRecognitionResult> | ApiErrorResponse | null> {
  try {
    const context = createContext(ports);
    const logPath = context.maaLogPath;
    logger.info('开始解析干员数据', { logPath });

    const logContent = await readFile(logPath, 'utf-8');

    // 查找所有 OperBoxInfo 行
    const lines = logContent.split('\n');
    const operBoxLines = lines.filter(line => line.includes('"what":"OperBoxInfo"'));

    if (operBoxLines.length === 0) {
      logger.warn('未找到 OperBoxInfo 数据');
      return null;
    }

    // 取最后一行
    const lastLine = operBoxLines[operBoxLines.length - 1];
    logger.info('找到 OperBoxInfo 数据');

    // 找到 JSON 对象的开始位置
    const jsonStart = lastLine.indexOf('{"class');
    if (jsonStart === -1) {
      throw new Error('无法找到 JSON 数据起始位置');
    }

    // 解析 JSON
    const jsonStr = lastLine.substring(jsonStart);
    const data = safeJsonParse(jsonStr);

    if (!isRecord(data) || !isRecord(data.details)) {
      throw new Error('解析 JSON 失败');
    }

    // 检查是否完成
    if (!data.details.done) {
      logger.warn('识别未完成，使用部分数据');
    }

    const opers = parseOperBoxOperators(data.details);
    if (!opers) {
      throw new Error('解析 JSON 失败');
    }
    logger.success(`解析成功，干员数量: ${opers.length}`);

    // 保存到文件
    await ensureDir(context.dataDir);
    const outputPath = join(context.dataDir, 'operbox.json');

    const output: OperBoxFile = {
      timestamp: new Date().toISOString(),
      operCount: opers.length,
      data: opers
    };

    await writeJsonFile(outputPath, output);
    logger.success('干员数据已保存', { path: outputPath });

    return successResponse({
      path: outputPath,
      operCount: opers.length,
      data: opers
    });
  } catch (error) {
    logger.error('解析干员数据失败', { error: errorMessage(error), stack: error instanceof Error ? error.stack : undefined });
    return errorResponse(error, '解析干员数据失败');
  }
}

/**
 * 读取已保存的仓库数据
 */
export async function getDepotData(ports: DataParserPorts = {}): Promise<DepotFile | null> {
  const context = createContext(ports);
  const filePath = join(context.dataDir, 'depot.json');
  const rawDepot = await readJsonFile(filePath, null);
  if (rawDepot === null) return null;

  const depot = parseDepotFile(rawDepot);
  if (!depot) {
    logger.warn('仓库缓存格式不符，按缺失处理', { path: filePath });
    return null;
  }
  return depot;
}

/**
 * 读取已保存的干员数据
 */
export async function getOperBoxData(ports: DataParserPorts = {}): Promise<OperBoxFile | null> {
  const context = createContext(ports);
  const filePath = join(context.dataDir, 'operbox.json');
  const rawOperBox = await readJsonFile(filePath, null);
  if (rawOperBox === null) return null;

  const operBox = parseOperBoxFile(rawOperBox);
  if (!operBox) {
    logger.warn('干员缓存格式不符，按缺失处理', { path: filePath });
    return null;
  }
  return operBox;
}

function parseOperator(id: string, value: unknown): OperatorSummary | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  if (typeof value.rarity !== 'number' || !Number.isFinite(value.rarity)) return null;

  const operator: OperatorSummary = { id, name: value.name, rarity: value.rarity };
  if (typeof value.profession === 'string') operator.profession = value.profession;
  if (typeof value.position === 'string') operator.position = value.position;
  return operator;
}

/**
 * 获取所有干员列表（从 MAA 资源文件）
 */
export async function getAllOperators(ports: DataParserPorts = {}): Promise<OperatorSummary[]> {
  try {
    const context = createContext(ports);
    const data = await readJsonFile(context.battleDataPath);

    if (!isRecord(data) || !isRecord(data.chars)) {
      throw new Error('无法读取干员数据');
    }

    // 从 chars 对象中提取所有干员
    const operators: OperatorSummary[] = [];
    for (const [id, char] of Object.entries(data.chars)) {
      // 过滤条件：
      // 1. ID以 char_ 开头（排除召唤物、陷阱等）
      // 2. 排除预备干员（char_5xx 和 char_6xx）
      if (!id.startsWith('char_')) continue;
      if (id.match(/^char_[56]\d{2}_/)) continue;

      const operator = parseOperator(id, char);
      if (!operator) continue;
      operators.push(operator);
    }

    operators.sort((a, b) => {
      // 按星级降序，同星级按名称排序
      if (b.rarity !== a.rarity) {
        return b.rarity - a.rarity;
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    logger.success(`加载所有干员成功，共 ${operators.length} 名干员（已过滤预备干员）`);
    return operators;
  } catch (error) {
    logger.error('加载所有干员失败', { error: errorMessage(error) });
    throw error;
  }
}
