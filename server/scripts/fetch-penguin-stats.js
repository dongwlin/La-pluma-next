/**
 * 从企鹅物流（penguin-stats.io）获取真实掉落统计数据
 *
 * 数据源：企鹅物流公开 API v2（无需鉴权，与 maa-cli --report-to-penguin 的上报渠道同源）
 * - /PenguinStats/api/v2/stages  关卡表：stageId、游戏内代号 code、理智消耗 apCost、所属章节
 * - /PenguinStats/api/v2/result/matrix  掉落矩阵：每关每物品的样本次数与总掉落数
 * - /PenguinStats/api/v2/zones  章节表：用于给关卡标记章节类型（主线/资源/别传等）
 *
 * 输出 server/data/penguin-drop-data.json：
 * - stages：stageId -> { code, apCost, zoneId, zoneType }
 * - dropMatrix：物品Id -> 该物品在各关卡的 { stageId, expected 期望掉落/次, samples 样本数 }（按样本数降序）
 *
 * 注意：企鹅物流矩阵只保留当前可刷关卡的数据，限时活动关过期后条目即被移除，
 * 因此矩阵条目本身就是「该关现在可刷」的过滤器，无需额外维护活动开放期数据。
 */

import { writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PENGUIN_API_BASE = 'https://penguin-stats.io/PenguinStats/api/v2';
const SERVER = 'CN';
const OUTPUT_FILE = join(__dirname, '../data/penguin-drop-data.json');

const REQUEST_HEADERS = {
  'User-Agent': 'LaPlumaNext/1.0 (https://github.com/dongwlin/La-pluma-next)',
  'Accept': 'application/json'
};

async function fetchJson(url) {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} while fetching ${url}`);
  }
  return response.json();
}

/**
 * 解析关卡表：跳过无代号或无理智消耗的关卡（剧情关、教学关等不可刷关卡）
 * 以及磨难难度关（tough_*）：磨难与普通关显示代号相同（如 10-2），
 * 但 maa fight 只会跑普通难度，磨难关的掉落统计不能混入选关
 */
function parseStages(stageList, zoneTypes) {
  const stages = {};
  for (const stage of stageList) {
    if (!stage.code || typeof stage.apCost !== 'number' || stage.apCost <= 0) continue;
    if (stage.stageId.startsWith('tough_')) continue;
    const cnExist = stage.existence?.CN;
    if (cnExist && cnExist.exist === false) continue;
    stages[stage.stageId] = {
      code: stage.code,
      apCost: stage.apCost,
      zoneId: stage.zoneId,
      zoneType: zoneTypes.get(stage.zoneId) || 'UNKNOWN'
    };
  }
  return stages;
}

/**
 * 构建按物品聚合的掉落矩阵：
 * 同一 (stageId, itemId) 可能有多段统计窗口（活动复刻等），按 qty/time 加权合并
 */
function buildDropMatrix(matrixEntries) {
  const dropMatrix = {};
  for (const entry of matrixEntries) {
    // 物品 Id 仅保留数字型（材料/理智/家具等），排除 furni、randomMaterial_x 等虚拟条目
    if (!/^\d+$/.test(entry.itemId)) continue;
    if (!entry.times || entry.times <= 0) continue;

    const itemEntries = (dropMatrix[entry.itemId] ||= []);
    const existing = itemEntries.find(e => e.stageId === entry.stageId);
    if (existing) {
      existing.quantity += entry.quantity;
      existing.times += entry.times;
    } else {
      itemEntries.push({ stageId: entry.stageId, quantity: entry.quantity, times: entry.times });
    }
  }

  let entryCount = 0;
  for (const itemEntries of Object.values(dropMatrix)) {
    for (const e of itemEntries) {
      e.expected = Number((e.quantity / e.times).toFixed(4));
      e.samples = e.times;
      delete e.quantity;
      delete e.times;
    }
    itemEntries.sort((a, b) => b.samples - a.samples);
    entryCount += itemEntries.length;
  }
  return { dropMatrix, entryCount };
}

async function main() {
  console.log(`正在从企鹅物流获取 ${SERVER} 服掉落统计数据...`);

  const [stageList, matrixResponse, zoneList] = await Promise.all([
    fetchJson(`${PENGUIN_API_BASE}/stages?server=${SERVER}`),
    fetchJson(`${PENGUIN_API_BASE}/result/matrix?server=${SERVER}`),
    fetchJson(`${PENGUIN_API_BASE}/zones?server=${SERVER}`)
  ]);

  const zoneTypes = new Map(zoneList.map(zone => [zone.zoneId, zone.type]));
  const stages = parseStages(stageList, zoneTypes);
  const { dropMatrix, entryCount } = buildDropMatrix(matrixResponse.matrix || []);

  const output = {
    metadata: {
      source: 'penguin-stats.io/PenguinStats/api/v2',
      server: SERVER,
      fetchedAt: new Date().toISOString(),
      stageCount: Object.keys(stages).length,
      itemCovered: Object.keys(dropMatrix).length,
      matrixEntryCount: entryCount
    },
    stages,
    dropMatrix
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(output), 'utf-8');

  console.log(`✅ 掉落统计数据已保存到: ${OUTPUT_FILE}`);
  console.log(`共 ${output.metadata.stageCount} 个关卡、${output.metadata.itemCovered} 种物品、${output.metadata.matrixEntryCount} 条掉落记录`);
}

main().catch(error => {
  console.error('❌ 获取企鹅物流掉落统计数据失败:', error.message);
  process.exit(1);
});
