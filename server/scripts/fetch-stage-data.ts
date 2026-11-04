import fetch from 'node-fetch';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  errorMessage,
  expectRecord,
  isDirectExecution,
  optionalNumber,
  optionalRecord,
  optionalString
} from './scriptSupport.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GAME_DATA_BASE = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata';
const STAGE_SOURCE = 'stage_table.json';

export const OUTPUT_DIR = path.join(__dirname, '../data');
export const OUTPUT_PATH = path.join(OUTPUT_DIR, 'stages.json');

export interface StageInfo {
  id: string;
  code: string;
  name: string;
  difficulty: string;
  dangerLevel: string;
  dangerPoint: number;
  apCost: number;
  stageType: string;
  thumbnail: string;
  zoneId: string;
  isMainStage: boolean;
  isActivityStage: boolean;
  isResourceStage: boolean;
}

async function fetchStageTable(): Promise<unknown> {
  console.log('📥 正在获取关卡表数据...');

  try {
    const response = await fetch(`${GAME_DATA_BASE}/excel/stage_table.json`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ 关卡表数据获取成功');
    return data;
  } catch (error) {
    console.error('❌ 获取关卡表失败:', errorMessage(error));
    throw error;
  }
}

export function parseStageData(payload: unknown): Record<string, StageInfo> {
  console.log('🔄 正在解析关卡数据...');

  const table = expectRecord(payload, STAGE_SOURCE);
  const stageData = optionalRecord(table.stages, STAGE_SOURCE, 'stages') ?? {};
  const stages: Record<string, StageInfo> = {};

  for (const [stageId, raw] of Object.entries(stageData)) {
    const stage = expectRecord(raw, STAGE_SOURCE, `关卡 ${stageId}`);
    const code = optionalString(stage.code);

    // 只处理主线、活动、别传关卡
    if (!code || code === 'null') continue;

    const stageType = optionalString(stage.stageType) || '';

    stages[code] = {
      id: stageId,
      code,
      name: optionalString(stage.name) || '',
      difficulty: optionalString(stage.difficulty) || '',
      dangerLevel: optionalString(stage.dangerLevel) || '',
      dangerPoint: optionalNumber(stage.dangerPoint) || 0,
      apCost: optionalNumber(stage.apCost) || 0,

      stageType,

      thumbnail: `https://web.hycdn.cn/arknights/game/assets/stage_pic/${stageId.replace(/#[fn]#/g, '')}.png`,

      zoneId: optionalString(stage.zoneId) || '',

      isMainStage: stageType === 'MAIN',

      isActivityStage: stageType === 'ACTIVITY' || stageType === 'CAMPAIGN',

      isResourceStage: stageType === 'DAILY' || stageType === 'WEEKLY'
    };
  }

  console.log(`✅ 解析完成，共 ${Object.keys(stages).length} 个关卡`);
  return stages;
}

export async function saveStageData(stages: Record<string, StageInfo>, deps: SaveStageDataDeps = {}): Promise<void> {
  console.log('💾 正在保存关卡数据...');

  const ensureDir = deps.mkdir ?? ((directory: string) => mkdir(directory, { recursive: true }));
  const write = deps.writeFile ?? ((filePath: string, data: string) => writeFile(filePath, data, 'utf-8'));
  const outputDir = deps.outputDir ?? OUTPUT_DIR;
  const outputPath = deps.outputPath ?? OUTPUT_PATH;

  try {
    await ensureDir(outputDir);

    await write(
      outputPath,
      JSON.stringify(stages, null, 2)
    );

    console.log('✅ 关卡数据已保存到:', outputPath);
    console.log(`📊 总计 ${Object.keys(stages).length} 个关卡`);

    const examples = Object.keys(stages).slice(0, 5);
    console.log('\n示例关卡:');
    examples.forEach(code => {
      const stage = stages[code];
      console.log(`  ${code}: ${stage.name} (${stage.stageType})`);
    });
  } catch (error) {
    console.error('❌ 保存关卡数据失败:', errorMessage(error));
    throw error;
  }
}

export interface SaveStageDataDeps {
  mkdir?: (directory: string) => Promise<void>;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  outputDir?: string;
  outputPath?: string;
}

export interface FetchStageDataDeps extends SaveStageDataDeps {
  fetchStageTable?: () => Promise<unknown>;
}

export async function main(deps: FetchStageDataDeps = {}): Promise<Record<string, StageInfo>> {
  const fetchTable = deps.fetchStageTable ?? fetchStageTable;

  console.log('========================================');
  console.log('   明日方舟关卡数据获取工具');
  console.log('========================================\n');

  const stageTable = await fetchTable();

  const stages = parseStageData(stageTable);

  await saveStageData(stages, deps);

  console.log('\n========================================');
  console.log('   ✅ 所有任务完成！');
  console.log('========================================');

  return stages;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('\n❌ 执行失败:', errorMessage(error));
    process.exit(1);
  });
}
