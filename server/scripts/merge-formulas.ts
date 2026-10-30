import { readFile, writeFile } from 'node:fs/promises';
import {
  errorMessage,
  expectRecord,
  isDirectExecution,
  optionalRecord,
  resolveTrainingDataPath,
  type JsonRecord
} from './scriptSupport.ts';

/** 输出/读取路径：materials.json 与 material-formulas.json 同属养成数据目录。 */
export const MATERIALS_PATH = resolveTrainingDataPath('materials.json');
export const FORMULAS_PATH = resolveTrainingDataPath('material-formulas.json');

/** 合并后的配方表。 */
export type RecipeTable = Record<string, JsonRecord>;

/** 合并结果。 */
export interface MergeFormulasResult {
  materials: JsonRecord;
  recipes: RecipeTable;
  mergedCount: number;
}

/** 校验配方表为“Id -> 配方对象”的结构。 */
function readRecipeTable(value: unknown, source: string, label: string): RecipeTable {
  const table = expectRecord(value, source, label);
  const recipes: RecipeTable = {};
  for (const [recipeId, raw] of Object.entries(table)) {
    recipes[recipeId] = expectRecord(raw, source, `${label}.${recipeId}`);
  }
  return recipes;
}

/**
 * 合并材料合成配方到 materials.json 的数据结构。
 * 新配方覆盖旧配方，materials 与其他顶层字段保持不变。
 */
export function mergeFormulaRecipes(materialsPayload: unknown, formulasPayload: unknown): MergeFormulasResult {
  const materials = expectRecord(materialsPayload, 'materials.json');
  const incoming = readRecipeTable(formulasPayload, 'material-formulas.json', '配方表');
  const existingRecipes = optionalRecord(materials.recipes, 'materials.json', 'recipes');
  const existing = existingRecipes === undefined
    ? {}
    : readRecipeTable(existingRecipes, 'materials.json', 'recipes');

  // 合并配方（新配方会覆盖旧配方）
  const recipes: RecipeTable = {
    ...existing,
    ...incoming
  };

  return {
    materials: { ...materials, recipes },
    recipes,
    mergedCount: Object.keys(recipes).length
  };
}

/** 测试与手工运行可替换的副作用端口。 */
export interface MergeFormulasDeps {
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  materialsPath?: string;
  formulasPath?: string;
}

/** 主函数：读取两个数据文件，合并配方后写回 materials.json。 */
export async function main(deps: MergeFormulasDeps = {}): Promise<MergeFormulasResult> {
  const read = deps.readFile ?? ((filePath: string) => readFile(filePath, 'utf-8'));
  const write = deps.writeFile ?? ((filePath: string, data: string) => writeFile(filePath, data, 'utf-8'));
  const materialsPath = deps.materialsPath ?? MATERIALS_PATH;
  const formulasPath = deps.formulasPath ?? FORMULAS_PATH;

  console.log('正在读取文件...');

  // 读取 materials.json
  const materialsData: unknown = JSON.parse(await read(materialsPath));

  // 读取 material-formulas.json
  const formulasData: unknown = JSON.parse(await read(formulasPath));

  const materialsRecord = expectRecord(materialsData, 'materials.json');
  const existingRecipes = optionalRecord(materialsRecord.recipes, 'materials.json', 'recipes');
  const existingRecipeCount = existingRecipes === undefined ? 0 : Object.keys(existingRecipes).length;
  const formulaCount = Object.keys(expectRecord(formulasData, 'material-formulas.json')).length;

  console.log(`materials.json 中有 ${existingRecipeCount} 个配方`);
  console.log(`material-formulas.json 中有 ${formulaCount} 个配方`);

  const result = mergeFormulaRecipes(materialsData, formulasData);

  console.log(`合并后共有 ${result.mergedCount} 个配方`);

  // 保存回 materials.json
  await write(materialsPath, JSON.stringify(result.materials, null, 2));

  console.log('✅ 配方已成功合并到 materials.json');

  // 验证 D32钢
  const d32 = result.recipes['30135'];
  if (d32) {
    console.log('\n✅ D32钢 (30135) 配方:');
    console.log(`  名称: ${d32.name}`);
    console.log(`  材料: ${JSON.stringify(d32.materials)}`);
  }

  return result;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('❌ 合并配方失败:', errorMessage(error));
    process.exit(1);
  });
}
