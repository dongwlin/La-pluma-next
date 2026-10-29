import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as allMaterials from '../fetch-all-materials.ts';
import * as gameAssets from '../fetch-game-assets.ts';
import * as materialFormulas from '../fetch-material-formulas.ts';
import * as operatorMaterials from '../fetch-operator-materials.ts';
import * as paradox from '../fetch-paradox-operators.ts';
import * as penguin from '../fetch-penguin-stats.ts';
import * as stageData from '../fetch-stage-data.ts';
import * as mergeFormulas from '../merge-formulas.ts';
import * as updateResources from '../update-maa-resources.ts';

const serverDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// 维护脚本的解析函数按原脚本保留进度日志；测试只关心结构与输出，静默本文件日志。
const originalLog = console.log;
before(() => {
  console.log = () => {};
});
after(() => {
  console.log = originalLog;
});

const CHARACTER_FIXTURE = {
  char_1001_alpha: {
    name: '阿尔法',
    rarity: 'TIER_4',
    profession: 'PIONEER',
    phases: [
      { evolveCost: [] },
      { evolveCost: [{ id: '4001', count: 30000 }, { id: '30011', count: 5 }] },
      { evolveCost: [{ id: '4001', count: 180000 }, { id: '30011', count: 10 }, { id: '3211', count: 3 }] }
    ]
  },
  char_1002_beta: {
    name: '贝塔',
    rarity: 5,
    profession: 'MYSTERY',
    phases: [
      {},
      { evolveCost: [{ id: '30012', count: 1 }] }
    ]
  },
  char_1003_gamma: {
    name: '伽马',
    rarity: 'TIER_3',
    profession: 'MEDIC',
    phases: [{}, { evolveCost: [{ id: '30011', count: 1 }] }]
  },
  char_1004_npc: {
    name: 'NPC',
    rarity: 'TIER_6',
    profession: 'MEDIC',
    phases: [{}, {}],
    isNotObtainable: true
  },
  enemy_1005: { name: '敌人', rarity: 'TIER_6', profession: 'MEDIC' }
};

const ITEM_FIXTURE = {
  items: {
    '30011': { name: '固源岩' },
    '3211': { name: '先锋芯片' }
  }
};

describe('fetch-operator-materials', () => {
  it('parses obtainable 4-star-and-above operators with elite materials', () => {
    const operators = operatorMaterials.parseOperatorMaterials(CHARACTER_FIXTURE, ITEM_FIXTURE);

    assert.deepEqual(Object.keys(operators), ['char_1001_alpha', 'char_1002_beta']);
    assert.deepEqual(operators.char_1001_alpha, {
      id: 'char_1001_alpha',
      name: '阿尔法',
      rarity: 4,
      profession: '先锋',
      elite1: {
        lmd: 30000,
        materials: [{ id: '30011', name: '固源岩', count: 5 }]
      },
      elite2: {
        lmd: 180000,
        materials: [{ id: '30011', name: '固源岩', count: 10 }],
        chips: [{ id: '3211', name: '先锋芯片', count: 3 }]
      }
    });
    assert.deepEqual(operators.char_1002_beta, {
      id: 'char_1002_beta',
      name: '贝塔',
      rarity: 6,
      profession: 'MYSTERY',
      elite1: {
        lmd: 0,
        materials: [{ id: '30012', name: '30012', count: 1 }]
      }
    });
  });

  it('rejects malformed external payloads before touching the filesystem', () => {
    assert.throws(
      () => operatorMaterials.parseOperatorMaterials({ broken: 1 }, ITEM_FIXTURE),
      /character_table\.json 数据格式无效/
    );
    assert.throws(
      () => operatorMaterials.parseOperatorMaterials(CHARACTER_FIXTURE, {}),
      /item_table\.json 数据格式无效/
    );
  });

  it('writes the configured output target with typed documentation metadata', async () => {
    const written: { path: string; data: string }[] = [];
    const output = await operatorMaterials.main({
      fetchJson: async url => (url.includes('character_table') ? CHARACTER_FIXTURE : ITEM_FIXTURE),
      writeFile: async (path, data) => {
        written.push({ path, data });
      },
      outputPath: '/virtual/operator-materials.json',
      now: () => new Date('2026-01-02T03:04:05.000Z')
    });

    assert.equal(written.length, 1);
    assert.equal(written[0].path, '/virtual/operator-materials.json');
    const persisted = JSON.parse(written[0].data) as { metadata: { lastUpdated: string; totalOperators: number } };
    assert.equal(persisted.metadata.lastUpdated, '2026-01-02');
    assert.equal(persisted.metadata.totalOperators, 2);
    assert.equal(output.metadata.totalOperators, 2);
  });
});

const BUILDING_FIXTURE = {
  workshopFormulas: {
    f1: { costs: [{ id: '30011', count: 2 }, { id: '30012', count: 0 }] }
  },
  manufactFormulas: {
    f2: { costs: [{ id: '30013', count: 1 }] }
  }
};

const FORMULA_ITEMS_FIXTURE = {
  items: {
    '3113': { name: '碳素', buildingProductList: [{ roomType: 'WORKSHOP', formulaId: 'f1' }] },
    '3114': { name: '碳素组', buildingProductList: [{ roomType: 'MANUFACTURE', formulaId: 'f2' }] },
    '3115': { name: '缺失配方', buildingProductList: [{ roomType: 'WORKSHOP', formulaId: 'nope' }] },
    '3116': { name: '无产物' }
  }
};

describe('fetch-material-formulas', () => {
  it('extracts craft and manufacture recipes and skips unmatched products', () => {
    const recipes = materialFormulas.extractMaterialFormulas(BUILDING_FIXTURE, FORMULA_ITEMS_FIXTURE);

    assert.deepEqual(recipes, {
      '3113': { id: '3113', name: '碳素', type: 'craft', materials: { '30011': 2 } },
      '3114': { id: '3114', name: '碳素组', type: 'manufacture', materials: { '30013': 1 } }
    });
  });

  it('rejects malformed building payloads', () => {
    assert.throws(
      () => materialFormulas.extractMaterialFormulas({ workshopFormulas: { f: { costs: 'bad' } } }, FORMULA_ITEMS_FIXTURE),
      /building_data\.json 数据格式无效/
    );
  });

  it('fetches both payloads and writes the recipes file', async () => {
    const urls: string[] = [];
    const written: { path: string; data: string }[] = [];
    await materialFormulas.main({
      fetchJson: async url => {
        urls.push(url);
        return url.includes('building_data') ? BUILDING_FIXTURE : FORMULA_ITEMS_FIXTURE;
      },
      writeFile: async (path, data) => {
        written.push({ path, data });
      },
      outputPath: '/virtual/material-formulas.json'
    });

    assert.equal(urls.length, 2);
    assert.equal(written.length, 1);
    assert.equal(written[0].path, '/virtual/material-formulas.json');
    assert.deepEqual(Object.keys(JSON.parse(written[0].data) as Record<string, unknown>), ['3113', '3114']);
  });
});

describe('merge-formulas', () => {
  const materialsFixture = {
    materials: { '30011': { id: '30011', name: '固源岩', rarity: 1 } },
    recipes: { '3113': { id: '3113', name: '旧配方', type: 'craft', materials: { '30012': 1 } } },
    stageSchedule: { '1-7': [{ day: 1 }] }
  };
  const formulasFixture = {
    '3113': { id: '3113', name: '新配方', type: 'craft', materials: { '30012': 2 } },
    '30135': { id: '30135', name: 'D32钢', type: 'craft', materials: { '30011': 1 } }
  };

  it('overrides existing recipes while keeping unrelated top-level fields', () => {
    const result = mergeFormulas.mergeFormulaRecipes(materialsFixture, formulasFixture);

    assert.equal(result.mergedCount, 2);
    assert.deepEqual(result.recipes['3113'], formulasFixture['3113']);
    assert.deepEqual(result.recipes['30135'], formulasFixture['30135']);
    assert.deepEqual(result.materials.materials, materialsFixture.materials);
    assert.deepEqual(result.materials.stageSchedule, materialsFixture.stageSchedule);
    // 合并构造新对象，不修改调用方传入的数据
    assert.equal(materialsFixture.recipes['3113'].name, '旧配方');
  });

  it('rejects non-object recipe tables', () => {
    assert.throws(() => mergeFormulas.mergeFormulaRecipes([], formulasFixture), /materials\.json 数据格式无效/);
    assert.throws(() => mergeFormulas.mergeFormulaRecipes(materialsFixture, []), /material-formulas\.json 数据格式无效/);
  });

  it('reads both files through the injected ports and writes back materials.json', async () => {
    const written: { path: string; data: string }[] = [];
    await mergeFormulas.main({
      readFile: async path => JSON.stringify(path.endsWith('material-formulas.json') ? formulasFixture : materialsFixture),
      writeFile: async (path, data) => {
        written.push({ path, data });
      },
      materialsPath: '/virtual/materials.json',
      formulasPath: '/virtual/material-formulas.json'
    });

    assert.equal(written.length, 1);
    assert.equal(written[0].path, '/virtual/materials.json');
    const persisted = JSON.parse(written[0].data) as { recipes: Record<string, { name: string }> };
    assert.equal(persisted.recipes['3113'].name, '新配方');
  });
});

const ALL_MATERIALS_FIXTURE = {
  items: {
    '30011': {
      name: '固源岩',
      itemType: 'MATERIAL',
      classifyType: 'MATERIAL',
      rarity: '1',
      stageDropList: [
        { stageId: 'main_01-07', occPer: 5000 },
        { stageId: 'main_02-01', occPer: '2500' },
        { stageId: 'main_03-01' },
        { stageId: 'main_04-01', occPer: 1000 }
      ]
    },
    '30042': { name: '异铁', itemType: 'MATERIAL', classifyType: 'MATERIAL', rarity: 2 },
    '4001': { name: '龙门币', itemType: 'GOLD', classifyType: 'GOLD', rarity: '1' }
  }
};

describe('fetch-all-materials', () => {
  it('keeps only MATERIAL items and derives the first three recommended stages', () => {
    const materials = allMaterials.parseMaterials(ALL_MATERIALS_FIXTURE);

    assert.deepEqual(Object.keys(materials), ['30011', '30042']);
    assert.deepEqual(materials['30011'], {
      id: '30011',
      name: '固源岩',
      rarity: 1,
      bestStages: [
        { stage: 'main_01-07', efficiency: 1, dropRate: 0.5 },
        { stage: 'main_02-01', efficiency: 1, dropRate: 0.25 }
      ]
    });
    assert.deepEqual(materials['30042'], { id: '30042', name: '异铁', rarity: 2 });
  });

  it('merges into the existing materials.json shape and drops unknown top-level keys', () => {
    const database = allMaterials.buildMaterialsDatabase(allMaterials.parseMaterials(ALL_MATERIALS_FIXTURE), {
      recipes: { '3113': { id: '3113' } },
      stageSchedule: { '1-7': [{ day: 1 }] },
      unknownField: true
    });

    assert.deepEqual(Object.keys(database), ['materials', 'recipes', 'stageSchedule']);
    assert.deepEqual(database.recipes, { '3113': { id: '3113' } });
    assert.deepEqual(database.stageSchedule, { '1-7': [{ day: 1 }] });
  });

  it('rejects material entries without a name', () => {
    assert.throws(
      () => allMaterials.parseMaterials({ items: { '30011': { itemType: 'MATERIAL', classifyType: 'MATERIAL' } } }),
      /item_table\.json 数据格式无效: 物品 30011 缺少名称/
    );
  });

  it('falls back to empty recipes when materials.json cannot be read', async () => {
    const written: { path: string; data: string }[] = [];
    await allMaterials.main({
      fetchJson: async () => ALL_MATERIALS_FIXTURE,
      readFile: async () => {
        throw new Error('ENOENT');
      },
      writeFile: async (path, data) => {
        written.push({ path, data });
      },
      materialsPath: '/virtual/materials.json'
    });

    assert.equal(written.length, 1);
    assert.equal(written[0].path, '/virtual/materials.json');
    const persisted = JSON.parse(written[0].data) as { materials: Record<string, unknown>; recipes: unknown };
    assert.equal(Object.keys(persisted.materials).length, 2);
    assert.deepEqual(persisted.recipes, {});
  });
});

const HANDBOOK_FIXTURE = {
  handbookStageData: {
    char_1001_alpha: { stageId: 'paradox_1', name: '阿尔法悖论' },
    char_1002_beta: { code: 'paradox_2' },
    char_1003_gamma: {},
    char_1004_delta: { stageId: 'paradox_4' }
  },
  handbookDict: {
    char_1002_beta: { infoName: '贝塔' }
  }
};

const HANDBOOK_CHARACTERS_FIXTURE = {
  char_1001_alpha: { name: '阿尔法' },
  char_1002_beta: {}
};

describe('fetch-paradox-operators', () => {
  it('keeps entries with a stage and resolves name fallbacks', () => {
    const operators = paradox.parseParadoxOperators(HANDBOOK_FIXTURE, HANDBOOK_CHARACTERS_FIXTURE);

    assert.deepEqual(operators.map(operator => operator.id).sort(), [
      'char_1001_alpha',
      'char_1002_beta',
      'char_1004_delta'
    ]);
    const byId = new Map(operators.map(operator => [operator.id, operator]));
    assert.deepEqual(byId.get('char_1001_alpha'), {
      id: 'char_1001_alpha',
      name: '阿尔法',
      stage_id: 'paradox_1',
      stage_name: '阿尔法悖论'
    });
    assert.deepEqual(byId.get('char_1002_beta'), {
      id: 'char_1002_beta',
      name: '贝塔',
      stage_id: 'paradox_2',
      stage_name: ''
    });
    assert.equal(byId.get('char_1004_delta')?.name, 'char_1004_delta');
  });

  it('rejects malformed handbook payloads', () => {
    assert.throws(
      () => paradox.parseParadoxOperators({ handbookStageData: [] }, HANDBOOK_CHARACTERS_FIXTURE),
      /handbook_info_table\.json 数据格式无效/
    );
  });

  it('writes the parsed operators through the injected ports', async () => {
    const written: { path: string; data: string }[] = [];
    const directories: string[] = [];
    await paradox.main({
      fetchJson: async name => (name === 'handbook_info_table.json' ? HANDBOOK_FIXTURE : HANDBOOK_CHARACTERS_FIXTURE),
      mkdir: async directory => {
        directories.push(directory);
      },
      writeFile: async (path, data) => {
        written.push({ path, data });
      },
      outputDir: '/virtual/data',
      outputPath: '/virtual/data/paradox-operators.json'
    });

    assert.deepEqual(directories, ['/virtual/data']);
    assert.equal(written.length, 1);
    assert.equal(written[0].path, '/virtual/data/paradox-operators.json');
    assert.equal((JSON.parse(written[0].data) as unknown[]).length, 3);
  });
});

const PENGUIN_STAGES_FIXTURE = [
  { stageId: 'main_01-07', code: '1-7', apCost: 6, zoneId: 'main_1' },
  { stageId: 'main_02-01', code: '2-1', apCost: 12, zoneId: 'main_2', existence: { CN: { exist: false } } },
  { stageId: 'tough_01-07', code: '1-7', apCost: 6, zoneId: 'main_1' },
  { stageId: 'main_03-01', code: '3-1', apCost: 0, zoneId: 'main_3' },
  { stageId: 'main_04-01', code: '', apCost: 8, zoneId: 'main_4' }
];

const PENGUIN_ZONES_FIXTURE = [{ zoneId: 'main_1', type: 'MAINLINE' }];

const PENGUIN_MATRIX_FIXTURE = {
  matrix: [
    { stageId: 'main_01-07', itemId: '30011', quantity: 100, times: 200 },
    { stageId: 'main_01-07', itemId: '30011', quantity: 300, times: 800 },
    { stageId: 'main_09-08', itemId: '30011', quantity: 1, times: 10 },
    { stageId: 'main_01-07', itemId: 'furni', quantity: 1, times: 1 },
    { stageId: 'main_01-07', itemId: '30012', quantity: 0, times: 0 }
  ]
};

describe('fetch-penguin-stats', () => {
  it('filters unavailable and tough stages and resolves zone types', () => {
    const zoneTypes = penguin.parseZoneTypes(PENGUIN_ZONES_FIXTURE);
    const stages = penguin.parseStages(PENGUIN_STAGES_FIXTURE, zoneTypes);

    assert.deepEqual(stages, {
      'main_01-07': { code: '1-7', apCost: 6, zoneId: 'main_1', zoneType: 'MAINLINE' }
    });
  });

  it('merges duplicate matrix windows by quantity and times', () => {
    const { dropMatrix, entryCount } = penguin.buildDropMatrix(PENGUIN_MATRIX_FIXTURE);

    assert.equal(entryCount, 2);
    assert.deepEqual(dropMatrix, {
      '30011': [
        { stageId: 'main_01-07', expected: 0.4, samples: 1000 },
        { stageId: 'main_09-08', expected: 0.1, samples: 10 }
      ]
    });
  });

  it('rejects non-numeric matrix counters', () => {
    assert.throws(
      () => penguin.buildDropMatrix({ matrix: [{ stageId: 'main_01-07', itemId: '30011', quantity: 1, times: '10' }] }),
      /times应为有限数字/
    );
  });

  it('assembles metadata and writes compact JSON to the configured target', async () => {
    const written: { path: string; data: string }[] = [];
    const output = await penguin.main({
      fetchJson: async url => {
        if (url.includes('/stages')) return PENGUIN_STAGES_FIXTURE;
        if (url.includes('/result/matrix')) return PENGUIN_MATRIX_FIXTURE;
        return PENGUIN_ZONES_FIXTURE;
      },
      writeFile: async (path, data) => {
        written.push({ path, data });
      },
      outputPath: '/virtual/penguin-drop-data.json',
      now: () => new Date('2026-01-02T03:04:05.000Z')
    });

    assert.equal(written.length, 1);
    assert.equal(written[0].path, '/virtual/penguin-drop-data.json');
    assert.equal(written[0].data, JSON.stringify(output));
    assert.deepEqual(output.metadata, {
      source: 'penguin-stats.io/PenguinStats/api/v2',
      server: 'CN',
      fetchedAt: '2026-01-02T03:04:05.000Z',
      stageCount: 1,
      itemCovered: 1,
      matrixEntryCount: 2
    });
  });
});

const STAGE_FIXTURE = {
  stages: {
    'main_01-07': {
      code: '1-7',
      name: '坍塌',
      difficulty: 'NORMAL',
      stageType: 'MAIN',
      zoneId: 'main_1',
      apCost: 6
    },
    'main_01-07#f#': {
      code: '1-7#f#',
      name: '坍塌',
      difficulty: 'FOUR_STAR',
      stageType: 'MAIN',
      zoneId: 'main_1',
      apCost: 6
    },
    'act_null': { code: 'null', name: '剧情', stageType: 'ACTIVITY' },
    'daily_ce_5': {
      code: 'CE-5',
      name: '龙门币',
      stageType: 'DAILY',
      dangerLevel: '高',
      dangerPoint: 10,
      apCost: 30
    },
    'no_code': { name: '无代号' }
  }
};

describe('fetch-stage-data', () => {
  it('keeps coded stages and derives thumbnail, zone and type flags', () => {
    const stages = stageData.parseStageData(STAGE_FIXTURE);

    assert.deepEqual(Object.keys(stages), ['1-7', '1-7#f#', 'CE-5']);
    assert.equal(
      stages['1-7'].thumbnail,
      'https://web.hycdn.cn/arknights/game/assets/stage_pic/main_01-07.png'
    );
    assert.equal(stages['1-7'].isMainStage, true);
    assert.equal(stages['1-7#f#'].thumbnail.endsWith('main_01-07.png'), true);
    assert.deepEqual(stages['CE-5'], {
      id: 'daily_ce_5',
      code: 'CE-5',
      name: '龙门币',
      difficulty: '',
      dangerLevel: '高',
      dangerPoint: 10,
      apCost: 30,
      stageType: 'DAILY',
      thumbnail: 'https://web.hycdn.cn/arknights/game/assets/stage_pic/daily_ce_5.png',
      zoneId: '',
      isMainStage: false,
      isActivityStage: false,
      isResourceStage: true
    });
  });

  it('rejects a non-object stage table', () => {
    assert.throws(() => stageData.parseStageData({ stages: [] }), /stage_table\.json 数据格式无效/);
  });

  it('runs the fetch and write ports end to end', async () => {
    const written: { path: string; data: string }[] = [];
    await stageData.main({
      fetchStageTable: async () => STAGE_FIXTURE,
      mkdir: async () => {},
      writeFile: async (path, data) => {
        written.push({ path, data });
      },
      outputDir: '/virtual/data',
      outputPath: '/virtual/data/stages.json'
    });

    assert.equal(written.length, 1);
    assert.equal(written[0].path, '/virtual/data/stages.json');
    assert.deepEqual(Object.keys(JSON.parse(written[0].data) as Record<string, unknown>), ['1-7', '1-7#f#', 'CE-5']);
  });
});

const GAME_CHARACTERS_FIXTURE = {
  char_1001_alpha: {
    name: '阿尔法',
    rarity: 'TIER_6',
    profession: 'PIONEER',
    subProfessionId: 'pioneer_1',
    skills: [{ skillId: 'sk1', levelUpCostCond: [] }]
  },
  trap_1: { name: '陷阱' },
  token_1: { name: '召唤物' },
  nameless: { rarity: 'TIER_1' }
};

const GAME_SKILLS_FIXTURE = {
  sk1: {
    iconId: 'icon_sk1',
    levels: [{ name: '技能1', description: '描述', spData: { spCost: 10 }, duration: 1.5 }]
  }
};

const GAME_ITEMS_FIXTURE = {
  items: {
    '30011': {
      name: '固源岩',
      description: '材料',
      rarity: 'TIER_1',
      itemType: 'MATERIAL',
      iconId: 'i1',
      classifyType: 'MATERIAL',
      obtainApproach: '通过关卡'
    }
  }
};

describe('fetch-game-assets', () => {
  it('skips traps, tokens and nameless character entries', () => {
    const characters = gameAssets.parseCharacterData(GAME_CHARACTERS_FIXTURE);

    assert.deepEqual(Object.keys(characters), ['char_1001_alpha']);
    assert.deepEqual(characters.char_1001_alpha.skills, [{ skillId: 'sk1', levelUpCostCond: [] }]);
    assert.equal(characters.char_1001_alpha.avatar, null);
  });

  it('parses skill levels and keeps the existing icon URL shape', () => {
    const skills = gameAssets.parseSkillData(GAME_SKILLS_FIXTURE);

    assert.deepEqual(skills, {
      sk1: {
        id: 'sk1',
        name: '技能1',
        icon: 'null/skill_icon/icon_sk1.png',
        levels: [{ name: '技能1', description: '描述', spData: { spCost: 10 }, duration: 1.5 }]
      }
    });
  });

  it('parses item entries and keeps the existing icon URL shape', () => {
    const items = gameAssets.parseItemData(GAME_ITEMS_FIXTURE);

    assert.deepEqual(items, {
      '30011': {
        id: '30011',
        name: '固源岩',
        description: '材料',
        rarity: 'TIER_1',
        itemType: 'MATERIAL',
        icon: 'null/item_icon/i1.png',
        classifyType: 'MATERIAL',
        obtainApproach: '通过关卡'
      }
    });
  });

  it('rejects malformed character skills', () => {
    assert.throws(
      () => gameAssets.parseCharacterData({ char_x: { name: '测试', skills: 'bad' } }),
      /character_table\.json 数据格式无效/
    );
  });

  it('writes characters, skills and items through the injected ports', async () => {
    const written: { path: string; data: string }[] = [];
    const directories: string[] = [];
    await gameAssets.main({
      fetchJson: async name => {
        if (name === 'character_table.json') return GAME_CHARACTERS_FIXTURE;
        if (name === 'skill_table.json') return GAME_SKILLS_FIXTURE;
        return GAME_ITEMS_FIXTURE;
      },
      mkdir: async directory => {
        directories.push(directory);
      },
      writeFile: async (path, data) => {
        written.push({ path, data });
      },
      outputDir: '/virtual/data'
    });

    assert.equal(directories.length, 3);
    assert.deepEqual(written.map(entry => entry.path), [
      join('/virtual/data', 'characters.json'),
      join('/virtual/data', 'skills.json'),
      join('/virtual/data', 'items.json')
    ]);
    assert.equal((JSON.parse(written[0].data) as Record<string, unknown>).char_1001_alpha !== undefined, true);
  });
});

describe('update-maa-resources', () => {
  it('resolves the resource directory from the MAA data directory command', () => {
    assert.equal(updateResources.getMaaResourceDir(() => '/maa/data'), '/maa/data/resource');
    assert.throws(() => updateResources.getMaaResourceDir(() => ''), /未返回数据目录/);
  });

  it('copies a directory recursively and removes it again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'la-pluma-scripts-'));
    try {
      const source = join(root, 'source');
      const destination = join(root, 'destination');
      mkdirSync(join(source, 'nested'), { recursive: true });
      writeFileSync(join(source, 'version.txt'), 'top');
      writeFileSync(join(source, 'nested', 'version.txt'), 'nested');

      updateResources.copyDir(source, destination);

      assert.equal(await readFile(join(destination, 'version.txt'), 'utf-8'), 'top');
      assert.equal(await readFile(join(destination, 'nested', 'version.txt'), 'utf-8'), 'nested');

      updateResources.removeDir(destination);
      assert.equal(existsSync(destination), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clones into the temp directory, copies resources and cleans up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'la-pluma-scripts-'));
    try {
      const dataDir = join(root, 'maa-data');
      const tempDir = join(root, 'temp-resource');
      await mkdir(join(dataDir, 'resource'), { recursive: true });

      await updateResources.updateResources({
        run: () => dataDir,
        tempDir,
        clone: () => {
          mkdirSync(join(tempDir, 'resource'), { recursive: true });
          writeFileSync(join(tempDir, 'resource', 'version.txt'), 'fixture');
        }
      });

      assert.equal(await readFile(join(dataDir, 'resource', 'version.txt'), 'utf-8'), 'fixture');
      assert.equal(existsSync(tempDir), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans the temp directory when the clone fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'la-pluma-scripts-'));
    try {
      const dataDir = join(root, 'maa-data');
      const tempDir = join(root, 'temp-resource');
      await mkdir(join(dataDir, 'resource'), { recursive: true });

      await assert.rejects(
        updateResources.updateResources({
          run: () => dataDir,
          tempDir,
          clone: () => {
            throw new Error('clone failed');
          }
        }),
        /Git 克隆失败/
      );
      assert.equal(existsSync(tempDir), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('maintenance script entry safety and targets', () => {
  const scriptNames = [
    'fetch-all-materials',
    'fetch-game-assets',
    'fetch-material-formulas',
    'fetch-operator-materials',
    'fetch-paradox-operators',
    'fetch-penguin-stats',
    'fetch-stage-data',
    'merge-formulas',
    'update-maa-resources'
  ];

  it('imports every maintenance script without running fetches or writes', () => {
    for (const name of scriptNames) {
      const url = new URL(`../${name}.ts`, import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
        { encoding: 'utf8', timeout: 30_000 }
      );
      assert.equal(result.status, 0, `${name} import failed: ${result.stderr}`);
      assert.equal(result.stdout, '', `${name} has import-time side effects`);
    }
  });

  it('detects direct execution in a CLI fixture without side effects on import', () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/directExecutionFixture.ts', import.meta.url));
    const direct = spawnSync(process.execPath, [fixturePath], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout.trim(), 'direct');

    const imported = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(fixturePath).href)})`],
      { encoding: 'utf8', timeout: 30_000 }
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout.trim(), 'imported');
  });

  it('writes each data script to its documented server/data target', () => {
    assert.equal(operatorMaterials.OUTPUT_PATH, join(serverDir, 'data', 'operator-materials.json'));
    assert.equal(materialFormulas.OUTPUT_PATH, join(serverDir, 'data', 'material-formulas.json'));
    assert.equal(mergeFormulas.MATERIALS_PATH, join(serverDir, 'data', 'materials.json'));
    assert.equal(mergeFormulas.FORMULAS_PATH, join(serverDir, 'data', 'material-formulas.json'));
    assert.equal(allMaterials.MATERIALS_PATH, join(serverDir, 'data', 'materials.json'));
    assert.equal(paradox.OUTPUT_PATH, join(serverDir, 'data', 'paradox-operators.json'));
    assert.equal(penguin.OUTPUT_PATH, join(serverDir, 'data', 'penguin-drop-data.json'));
    assert.equal(stageData.OUTPUT_PATH, join(serverDir, 'data', 'stages.json'));
    assert.equal(gameAssets.OUTPUT_DIR, join(serverDir, 'data'));
    assert.equal(updateResources.TEMP_DIR, join(serverDir, '.temp-maa-resource'));
  });

  it('keeps every package script pointing at an existing script file', async () => {
    const { scripts } = JSON.parse(await readFile(join(serverDir, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const referenced = [...new Set(Object.values(scripts).flatMap(command => (
      [...command.matchAll(/scripts\/[\w-]+\.(?:ts|js)/g)].map(match => match[0])
    )))];

    assert.ok(referenced.length > 0);
    for (const file of referenced) {
      assert.equal(existsSync(join(serverDir, file)), true, `package script references missing ${file}`);
    }
  });
});
