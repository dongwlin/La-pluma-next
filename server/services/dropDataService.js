/**
 * 企鹅物流掉落数据服务
 *
 * 数据文件 server/data/penguin-drop-data.json 由 scripts/fetch-penguin-stats.js 生成
 * （数据源企鹅物流公开 API v2，server=CN，抓取时间见 metadata.fetchedAt）。
 *
 * 提供两类查询：
 * - findBestFarmStage：全矩阵按物品反查最优刷取关卡（仅限永久关卡，避免计划排进随时会关闭的限时活动关）
 * - getStageEstimate：指定关卡的指定物品期望掉落（用于芯片等固定映射关卡）
 *
 * 查询失败返回 null，由调用方决定回退策略——本服务不做任何硬编码兜底。
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readJsonFile } from '../utils/fileHelper.js';
import { createLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PENGUIN_DROP_DATA_PATH = path.join(__dirname, '../data/penguin-drop-data.json');

const logger = createLogger('DropData');

/**
 * 可长期刷取的章节类型。临时活动（ACTIVITY）不参与最优关反查：
 * 活动关闭后计划仍会被调度器执行，刷取会失败；企鹅矩阵对限时活动关
 * 的统计在活动结束后即下架，但缓存的数据文件在下次刷新前仍是旧快照，
 * 因此只信任永久关卡（主线/支线/资源本/别传）。
 */
const PERMANENT_ZONE_TYPES = new Set(['MAINLINE', 'SUB', 'WEEKLY', 'ACTIVITY_PERMANENT']);

/**
 * 样本数下限：低于该值的统计波动过大（新关首日样本），不参与估算
 */
const MIN_STAGE_SAMPLES = 50;

/**
 * 加载企鹅物流掉落数据
 * @returns {object|null} 数据缺失或损坏时返回 null，由调用方回退到经验估算并 warn
 */
export async function loadPenguinDropData() {
  const data = await readJsonFile(PENGUIN_DROP_DATA_PATH, null);
  if (!data || !data.stages || !data.dropMatrix) {
    logger.warn('企鹅物流掉落数据不可用（未生成或格式不符），请先执行 fetch-penguin-stats 脚本');
    return null;
  }
  return data;
}

/**
 * 查询指定物品在指定关卡的期望掉落
 * @param {string} stageRef 关卡代号（如 PR-A-1）或 stageId（如 pro_a_1）
 * @param {string} itemId 物品 Id
 * @returns {{ stageId: string, code: string, apCost: number, expectedPerRun: number, samples: number }|null}
 */
export function getStageEstimate(stageRef, itemId, dropData) {
  if (!dropData || !stageRef || !itemId) return null;

  const ref = String(stageRef);
  let stageId = dropData.stages[ref] ? ref : null;
  if (!stageId) {
    // 兼容按关卡代号查询（如芯片映射表里的 PR-A-1）
    stageId = Object.keys(dropData.stages).find(id => dropData.stages[id].code === ref.toUpperCase());
  }
  if (!stageId) return null;

  const stage = dropData.stages[stageId];
  const entry = findMatrixEntry(dropData, stageId, itemId);

  if (!entry || entry.samples < MIN_STAGE_SAMPLES) return null;

  return {
    stageId,
    code: stage.code,
    apCost: stage.apCost,
    expectedPerRun: entry.expected,
    samples: entry.samples
  };
}

/**
 * 全矩阵反查物品的最优刷取关卡：按「期望理智消耗/个」（apCost / 期望掉落）升序取最优。
 * 仅考虑永久关卡，样本数低于下限的关卡忽略。
 * @returns {{ stageId: string, code: string, apCost: number, expectedPerRun: number, samples: number }|null}
 */
export function findBestFarmStage(itemId, dropData) {
  if (!dropData || !itemId) return null;

  const itemEntries = dropData.dropMatrix[itemId];
  if (!Array.isArray(itemEntries)) return null;

  let best = null;
  let bestEfficiency = Infinity;

  for (const entry of itemEntries) {
    if (entry.samples < MIN_STAGE_SAMPLES) continue;

    const stage = dropData.stages[entry.stageId];
    if (!stage) continue;
    if (!PERMANENT_ZONE_TYPES.has(stage.zoneType)) continue;

    if (entry.expected <= 0) continue;
    const efficiency = stage.apCost / entry.expected;
    if (efficiency < bestEfficiency) {
      bestEfficiency = efficiency;
      best = {
        stageId: entry.stageId,
        code: stage.code,
        apCost: stage.apCost,
        expectedPerRun: entry.expected,
        samples: entry.samples
      };
    }
  }

  return best;
}

function findMatrixEntry(dropData, stageId, itemId) {
  const itemEntries = dropData.dropMatrix[itemId];
  if (!Array.isArray(itemEntries)) return null;
  const direct = itemEntries.find(entry => entry.stageId === stageId);
  if (direct) return direct;
  // 别传关在企鹅矩阵中的 stageId 带 _perm 后缀（如 act19side_07_perm）
  return itemEntries.find(entry => entry.stageId === `${stageId}_perm`) || null;
}
