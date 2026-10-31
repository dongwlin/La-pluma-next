/**
 * 掉落记录服务
 * 记录和管理每日的材料掉落数据
 */

import path from 'path';
import { readJsonFile, ensureDir, updateJsonFile } from '../utils/fileHelper.ts';
import { successResponse, errorResponse } from '../utils/apiHelper.ts';
import type { ApiErrorResponse, ApiSuccessResponse } from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts';
import { resolveBoundedInteger } from '../utils/numericQueryHelper.ts';
import { resolveAppPaths } from '../config/runtimeConfig.ts';

const logger = createLogger('DropRecord');

const APP_PATHS = resolveAppPaths();

// 历史查询按天读取记录文件，天数上限防止非法 query 触发无界文件读取；
// 目录支持环境变量注入，供测试隔离运行数据。
export const MAX_DROP_HISTORY_DAYS = 365;
const DROP_RECORDS_DIR = APP_PATHS.dropRecordsDir;
const MATERIALS_PATH = APP_PATHS.materialsPath;

/** 单次掉落中的一项材料。 */
export interface DropItem {
  name: string;
  count: number;
}

/** 记录一次掉落的输入；缺省字段沿用既有默认值。 */
export interface DropRecordInput {
  stage: string;
  times?: number;
  sanity?: number;
  medicine?: number;
  stone?: number;
  items?: DropItem[];
  source?: string;
  mode?: string;
}

/** 落盘的单条掉落记录。 */
export interface DropRecordEntry {
  timestamp: string;
  stage: string;
  times: number;
  sanity: number;
  medicine: number;
  stone: number;
  items: DropItem[];
  source: string;
  mode: string;
}

/** 单日汇总；itemsSummary 以材料名累计数量。 */
export interface DropRecordSummary {
  totalSanity: number;
  totalMedicine: number;
  totalStone: number;
  totalBattles: number;
  itemsSummary: Record<string, number>;
}

/** 单日记录文件。 */
export interface DropRecordDay {
  date: string;
  records: DropRecordEntry[];
  summary: DropRecordSummary;
}

/** 材料表中统计需要的字段；缺失时统计输出 null。 */
export interface MaterialEntry {
  iconId?: string;
  rarity?: number;
}

/** 统计结果的物品视图。 */
export interface DropStatisticsItem {
  count: number;
  stages: Record<string, number>;
  iconId: string | null;
  rarity: number | null;
}

/** 统计结果的关卡视图。 */
export interface DropStatisticsStage {
  battles: number;
  sanity: number;
  items: Record<string, number>;
}

/** 统计结果的每日趋势条目。 */
export interface DropStatisticsDailyTrend {
  date: string;
  sanity: number;
  medicine: number;
  stone: number;
  battles: number;
  items: Record<string, number>;
}

/** 掉落统计响应体。 */
export interface DropStatistics {
  dateRange: {
    start: string | null;
    end: string | null;
    days: number;
  };
  total: {
    sanity: number;
    medicine: number;
    stone: number;
    battles: number;
  };
  items: Record<string, DropStatisticsItem>;
  stages: Record<string, DropStatisticsStage>;
  dailyTrend: DropStatisticsDailyTrend[];
}

/** 记录目录与材料表路径的覆盖入口，供测试指向临时 fixture。 */
export interface DropRecordPorts {
  recordsDir?: string;
  materialsPath?: string;
}

// 业务日期统一使用服务器配置时区，避免北京时间凌晨落到前一天。
export function getLocalDateString(date = new Date(), timeZone = process.env.TZ || 'Asia/Shanghai'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function parseDropItem(value: unknown): DropItem | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const count = readNumber(value.count);
  if (count === null) return null;
  return { name: value.name, count };
}

/**
 * 单条记录解析。source/mode 是后加字段，旧记录缺失时按默认值补齐；
 * 其余字段必须存在且类型正确，任何一项不符都让整份记录按损坏处理，
 * 避免按缺省值重算汇总而丢历史数量。
 */
function parseDropRecordEntry(value: unknown): DropRecordEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.timestamp !== 'string' || typeof value.stage !== 'string') return null;
  if (!Array.isArray(value.items)) return null;

  const times = readNumber(value.times);
  const sanity = readNumber(value.sanity);
  const medicine = readNumber(value.medicine);
  const stone = readNumber(value.stone);
  if (times === null || sanity === null || medicine === null || stone === null) return null;

  const items: DropItem[] = [];
  for (const rawItem of value.items) {
    const item = parseDropItem(rawItem);
    if (!item) return null;
    items.push(item);
  }

  return {
    timestamp: value.timestamp,
    stage: value.stage,
    times,
    sanity,
    medicine,
    stone,
    items,
    source: readString(value.source, 'fight'),
    mode: readString(value.mode, 'normal')
  };
}

function parseDropRecordSummary(value: unknown): DropRecordSummary | null {
  if (!isRecord(value) || !isRecord(value.itemsSummary)) return null;

  const totalSanity = readNumber(value.totalSanity);
  const totalMedicine = readNumber(value.totalMedicine);
  const totalStone = readNumber(value.totalStone);
  const totalBattles = readNumber(value.totalBattles);
  if (totalSanity === null || totalMedicine === null || totalStone === null || totalBattles === null) {
    return null;
  }

  const itemsSummary: Record<string, number> = {};
  for (const [name, count] of Object.entries(value.itemsSummary)) {
    const numericCount = readNumber(count);
    if (numericCount === null) return null;
    itemsSummary[name] = numericCount;
  }

  return { totalSanity, totalMedicine, totalStone, totalBattles, itemsSummary };
}

/**
 * 把单日记录文件解析为领域类型。
 * 缺少 date/records/summary 或任一记录、材料条目结构不符时返回 null：
 * 读取历史时跳过该文件并 warn，写入时按失败处理，不静默重建损坏的记录。
 */
export function parseDropRecordDay(value: unknown): DropRecordDay | null {
  if (!isRecord(value)) return null;
  if (typeof value.date !== 'string' || !Array.isArray(value.records)) return null;

  const summary = parseDropRecordSummary(value.summary);
  if (!summary) return null;

  const records: DropRecordEntry[] = [];
  for (const rawRecord of value.records) {
    const record = parseDropRecordEntry(rawRecord);
    if (!record) return null;
    records.push(record);
  }

  return { date: value.date, records, summary };
}

// 获取今天的记录文件路径
function getTodayRecordPath(recordsDir: string): string {
  return path.join(recordsDir, `${getLocalDateString()}.json`);
}

// 创建空记录结构
function createEmptyRecord(date = getLocalDateString()): DropRecordDay {
  return {
    date,
    records: [],
    summary: {
      totalSanity: 0,
      totalMedicine: 0,
      totalStone: 0,
      totalBattles: 0,
      itemsSummary: {}
    }
  };
}

function resolveRecordsDir(ports: DropRecordPorts): string {
  return ports.recordsDir || DROP_RECORDS_DIR;
}

/**
 * 记录掉落数据
 */
export async function recordDrops(
  dropData: DropRecordInput,
  ports: DropRecordPorts = {}
): Promise<ApiSuccessResponse<{ record: DropRecordDay }> | ApiErrorResponse> {
  try {
    const recordsDir = resolveRecordsDir(ports);
    await ensureDir(recordsDir);
    const recordPath = getTodayRecordPath(recordsDir);

    // 使用 updateJsonFile 简化读取-修改-写入流程
    const todayRecord = await updateJsonFile<DropRecordDay>(
      recordPath,
      (existingRecord) => {
        const record = existingRecord ? parseDropRecordDay(existingRecord) : createEmptyRecord();
        if (!record) {
          // 既有文件不是可识别的记录结构：保持失败，不能覆盖或清空历史。
          throw new Error('掉落记录格式无效');
        }

        // 添加新记录
        const newRecord: DropRecordEntry = {
          timestamp: new Date().toISOString(),
          stage: dropData.stage,
          times: dropData.times || 1,
          sanity: dropData.sanity || 0,
          medicine: dropData.medicine || 0,
          stone: dropData.stone || 0,
          items: dropData.items || [],
          source: dropData.source || 'fight',
          mode: dropData.mode || 'normal'
        };

        record.records.push(newRecord);

        // 更新汇总数据
        record.summary.totalSanity += newRecord.sanity;
        record.summary.totalMedicine += newRecord.medicine;
        record.summary.totalStone += newRecord.stone;
        record.summary.totalBattles += newRecord.times;

        // 更新物品汇总
        for (const item of newRecord.items) {
          if (!record.summary.itemsSummary[item.name]) {
            record.summary.itemsSummary[item.name] = 0;
          }
          record.summary.itemsSummary[item.name] += item.count;
        }

        return record;
      },
      createEmptyRecord()
    );

    logger.debug('已记录掉落', { stage: dropData.stage, times: dropData.times });
    return successResponse({ record: todayRecord });
  } catch (error) {
    logger.error('记录掉落失败', {
      error: error instanceof Error ? error.message : String(error)
    });
    return errorResponse(error, '记录掉落失败');
  }
}

/**
 * 获取今天的掉落记录
 */
export async function getTodayDrops(
  ports: DropRecordPorts = {}
): Promise<ApiSuccessResponse<DropRecordDay> | ApiErrorResponse> {
  try {
    const recordsDir = resolveRecordsDir(ports);
    await ensureDir(recordsDir);
    const recordPath = getTodayRecordPath(recordsDir);
    const rawRecord = await readJsonFile(recordPath, null);
    // 文件不存在时沿用既有行为：返回当天的空记录。
    const record = rawRecord === null ? createEmptyRecord() : parseDropRecordDay(rawRecord);
    if (!record) {
      throw new Error('掉落记录格式无效');
    }
    return successResponse(record);
  } catch (error) {
    logger.error('获取今日记录失败', {
      error: error instanceof Error ? error.message : String(error)
    });
    return errorResponse(error, '获取今日记录失败');
  }
}

/**
 * 获取指定日期范围的掉落记录
 */
export async function getRecentDrops(
  days: unknown = 7,
  ports: DropRecordPorts = {}
): Promise<ApiSuccessResponse<DropRecordDay[]> | ApiErrorResponse> {
  try {
    const recordsDir = resolveRecordsDir(ports);
    // 直接调用也受限：非法输入回落默认值，有限值截断并夹取到历史上限天数。
    const dayCount = resolveBoundedInteger(days, {
      defaultValue: 7,
      min: 1,
      max: MAX_DROP_HISTORY_DAYS
    });
    await ensureDir(recordsDir);

    const records: DropRecordDay[] = [];
    const today = new Date();

    for (let i = 0; i < dayCount; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = getLocalDateString(date);
      const recordPath = path.join(recordsDir, `${dateStr}.json`);

      const rawRecord = await readJsonFile(recordPath, null);
      if (rawRecord === null) continue;

      const record = parseDropRecordDay(rawRecord);
      if (!record) {
        // 单日文件结构不符只影响当天：跳过并保留其它日期可读。
        logger.warn('跳过格式不符的掉落记录文件', { path: recordPath });
        continue;
      }
      records.push(record);
    }

    return successResponse(records);
  } catch (error) {
    logger.error('获取历史记录失败', {
      error: error instanceof Error ? error.message : String(error)
    });
    return errorResponse(error, '获取历史记录失败');
  }
}

/**
 * 获取掉落统计（按物品汇总）
 */
export async function getDropStatistics(
  days: unknown = 7,
  ports: DropRecordPorts = {}
): Promise<ApiSuccessResponse<DropStatistics> | ApiErrorResponse> {
  try {
    const recentResult = await getRecentDrops(days, ports);
    if (!recentResult.success) {
      return recentResult;
    }

    const records = recentResult.data;

    // 汇总统计
    const statistics: DropStatistics = {
      dateRange: {
        start: records.length > 0 ? records[records.length - 1].date : null,
        end: records.length > 0 ? records[0].date : null,
        days: records.length
      },
      total: {
        sanity: 0,
        medicine: 0,
        stone: 0,
        battles: 0
      },
      items: {},
      stages: {},
      dailyTrend: []
    };

    // 加载材料数据
    const materialsMap = await loadMaterialsMap(ports);

    // 遍历每天的记录
    for (const dayRecord of records) {
      const dailyData: DropStatisticsDailyTrend = {
        date: dayRecord.date,
        sanity: dayRecord.summary.totalSanity,
        medicine: dayRecord.summary.totalMedicine,
        stone: dayRecord.summary.totalStone,
        battles: dayRecord.summary.totalBattles,
        items: dayRecord.summary.itemsSummary
      };

      statistics.dailyTrend.push(dailyData);

      // 累加总计
      statistics.total.sanity += dayRecord.summary.totalSanity;
      statistics.total.medicine += dayRecord.summary.totalMedicine;
      statistics.total.stone += dayRecord.summary.totalStone;
      statistics.total.battles += dayRecord.summary.totalBattles;

      // 遍历每条记录
      for (const record of dayRecord.records) {
        processRecordForStatistics(record, statistics, materialsMap);
      }
    }

    // 反转 dailyTrend，使其按时间正序排列
    statistics.dailyTrend.reverse();

    return successResponse(statistics);
  } catch (error) {
    logger.error('获取统计数据失败', {
      error: error instanceof Error ? error.message : String(error)
    });
    return errorResponse(error, '获取统计数据失败');
  }
}

function parseMaterialEntry(value: unknown): { name: string; entry: MaterialEntry } | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const entry: MaterialEntry = {};
  if (typeof value.iconId === 'string') entry.iconId = value.iconId;
  if (typeof value.rarity === 'number' && Number.isFinite(value.rarity)) entry.rarity = value.rarity;
  return { name: value.name, entry };
}

// 加载材料数据映射
async function loadMaterialsMap(ports: DropRecordPorts): Promise<Record<string, MaterialEntry>> {
  try {
    const materialsPath = ports.materialsPath || MATERIALS_PATH;
    const materials = await readJsonFile(materialsPath, []);
    // 统计只读取既有数组格式的材料表；对象格式（含 materials/recipes 段）保持既有行为，返回空映射。
    if (!Array.isArray(materials)) {
      logger.warn('材料数据格式错误，应为数组', { type: typeof materials });
      return {};
    }
    const map: Record<string, MaterialEntry> = {};
    for (const item of materials) {
      const parsed = parseMaterialEntry(item);
      if (!parsed) continue;
      map[parsed.name] = parsed.entry;
    }
    return map;
  } catch (error) {
    logger.warn('无法加载材料数据', {
      error: error instanceof Error ? error.message : String(error)
    });
    return {};
  }
}

// 处理单条记录的统计
function processRecordForStatistics(
  record: DropRecordEntry,
  statistics: DropStatistics,
  materialsMap: Record<string, MaterialEntry>
): void {
  const stageName = record.stage;

  // 统计关卡数据
  if (!statistics.stages[stageName]) {
    statistics.stages[stageName] = {
      battles: 0,
      sanity: 0,
      items: {}
    };
  }
  statistics.stages[stageName].battles += record.times;
  statistics.stages[stageName].sanity += record.sanity;

  // 统计物品数据
  for (const item of record.items) {
    const itemName = item.name;

    // 全局物品统计
    if (!statistics.items[itemName]) {
      statistics.items[itemName] = {
        count: 0,
        stages: {},
        iconId: materialsMap[itemName]?.iconId ?? null,
        rarity: materialsMap[itemName]?.rarity ?? null
      };
    }
    statistics.items[itemName].count += item.count;

    // 物品在各关卡的掉落统计
    if (!statistics.items[itemName].stages[stageName]) {
      statistics.items[itemName].stages[stageName] = 0;
    }
    statistics.items[itemName].stages[stageName] += item.count;

    // 关卡的物品掉落统计
    if (!statistics.stages[stageName].items[itemName]) {
      statistics.stages[stageName].items[itemName] = 0;
    }
    statistics.stages[stageName].items[itemName] += item.count;
  }
}
