import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createInfrastScheduleService,
  validateInfrastScheduleDocument,
  INFRASTRUCT_SCHEDULE_ERROR_CODES,
  INFRASTRUCT_SCHEDULE_FACILITIES,
  INFRASTRUCT_SCHEDULE_PRODUCTS
} from '../infrastScheduleService.ts';
import type { InfrastScheduleService } from '../infrastScheduleService.ts';

const tempDirs: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) assert.fail(`${label} 必须是 JSON 对象`);
  return value;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function expectServiceError(
  action: () => Promise<unknown>,
  expected: { code: string; statusCode: number; retryable?: boolean }
): Promise<Record<string, unknown>> {
  let thrown: unknown = null;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== null, 'expected the operation to reject');
  const error = requireRecord(thrown, 'service error');
  assert.equal(error.code, expected.code);
  assert.equal(error.statusCode, expected.statusCode);
  if (expected.retryable !== undefined) {
    assert.equal(error.retryable, expected.retryable);
  }
  return error;
}

function permissionError(): Error {
  return Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
}

/**
 * 取自 MaaAssistantArknights resource/custom_infrast 的真实结构：包含官方文件的
 * author/id/title/planTimes/scheduleType 以及排班表扩充协议的 layout/operators/metadata，
 * 并叠加 Core 协议全部可选字段与未知扩展字段。
 */
function realUserScheduleFixture(): Record<string, unknown> {
  return {
    author: '测试作者',
    id: 1779034959998915,
    title: '243-高配3队简化',
    planTimes: '3班',
    scheduleType: { planTimes: 3, trading: 2, manufacture: 4, power: 3, dormitory: 4 },
    buildingType: '243',
    layout: [
      { type: 'control', level: 5 },
      { type: 'trading', level: 3, position: 'B101' },
      { type: 'manufacture', level: 3, position: 'B201' }
    ],
    operators: {
      char_002_amiya: { name: '阿米娅', elite: 2, level: 80 },
      char_124_kroos: { name: '克洛丝', elite: 1, level: 55 }
    },
    metadata: {
      extensionVersion: '1.0',
      generator: {
        id: 'yituliu-riic-schedule-generator',
        name: '明日方舟一图流-排班表自动生成工具',
        url: 'https://ark.yituliu.cn/tools/scheduleV3'
      },
      moduleVersions: { layout: 'v20260924.2314', data: 'v20260924.2314' }
    },
    description: '243-高配3队简化\n干员配置要求极高',
    plans: [
      {
        name: '早班',
        description: '早班说明',
        description_post: '早班完成',
        period: [['22:00', '23:59'], ['00:00', '06:00']],
        duration: 360,
        Fiammetta: { enable: true, target: '巫恋', order: 'pre' },
        drones: { enable: true, room: 'trading', index: 2, rule: 'all', order: 'post' },
        groups: [
          { name: '古+银', operators: ['古米', '银灰', '梅'] },
          { name: '清流', operators: ['清流', '森蚺', '温蒂'] }
        ],
        unknownPlanExtension: { keep: ['as-is'] },
        rooms: {
          control: [{ operators: ['夕', '令', '凯尔希'] }],
          manufacture: [
            { operators: ['芬', '稀音', '克洛丝'], sort: true, product: 'Battle Record', autofill: false },
            { skip: true },
            { operators: ['多萝西'], candidates: ['星源', '白面鸮', '赫默'] },
            { use_operator_groups: true, operators: ['古+银'], unknownRoomExtension: { nested: true } }
          ],
          trading: [{ operators: ['黑键', '吉星'], product: 'LMD', sort: true }],
          power: [],
          meeting: [{ autofill: true }],
          hire: [{}],
          dormitory: [{ operators: [] }],
          processing: [{ operators: ['承曦格雷伊'] }],
          training: [{ operatorsA: ['杜宾'], operatorsB: ['银灰'] }],
          recycle: [{ operators: ['芬', '克洛丝'], product: 'LMD' }],
          futureFacility: [{ operators: ['未来干员'] }]
        }
      },
      { name: '晚班', rooms: { control: [{ operators: ['玛恩纳'] }] } }
    ]
  };
}

function minimalScheduleDocument(): Record<string, unknown> {
  return { plans: [{ rooms: {} }] };
}

describe('infrast schedule protocol constants', () => {
  it('exposes the documented facilities and products', () => {
    assert.deepEqual(
      [...INFRASTRUCT_SCHEDULE_FACILITIES],
      ['control', 'manufacture', 'trading', 'power', 'meeting', 'hire', 'dormitory', 'processing', 'training', 'recycle']
    );
    assert.deepEqual(
      [...INFRASTRUCT_SCHEDULE_PRODUCTS],
      ['Battle Record', 'Pure Gold', 'Dualchip', 'Originium Shard', 'LMD', 'Orundum']
    );
  });
});

describe('validateInfrastScheduleDocument', () => {
  const acceptedCases: Array<[string, unknown]> = [
    ['minimal Core-required document', minimalScheduleDocument()],
    ['plan with only the required rooms object', { plans: [{ name: '早班', rooms: {} }] }],
    ['empty optional arrays and object fields', {
      title: 'title',
      description: 'description',
      plans: [{ name: 'plan', period: [], groups: [], rooms: { manufacture: [] } }]
    }],
    ['disabled Fiammetta and drones from official schedules', {
      plans: [{
        Fiammetta: { enable: false, target: '', order: 'pre' },
        drones: { enable: false, room: 'manufacture', index: 3, order: 'pre' },
        rooms: { trading: [] }
      }]
    }],
    ['product on non-production facilities stays tolerated', {
      plans: [{ rooms: { recycle: [{ operators: ['芬'], product: 'LMD' }], power: [{ product: 'anything' }] } }]
    }],
    ['product strings outside the documented editor list', {
      plans: [{
        rooms: {
          manufacture: [{ product: 'Future Product' }],
          trading: [{ product: '未来贸易产物' }]
        }
      }]
    }],
    ['unknown top-level, plan, room and facility fields', realUserScheduleFixture()]
  ];

  for (const [label, document] of acceptedCases) {
    it(`accepts ${label}`, () => {
      assert.equal(validateInfrastScheduleDocument(document), null);
    });
  }

  const rejectedCases: Array<[string, unknown, string]> = [
    ['non-object document', null, '排班表必须是 JSON 对象'],
    ['array document', [], '排班表必须是 JSON 对象'],
    ['missing plans', {}, 'plans 缺失'],
    ['empty plans', { plans: [] }, 'plans 不能为空'],
    ['non-array plans', { plans: {} }, 'plans 必须是数组'],
    ['non-object plan', { plans: ['x'] }, 'plans[0] 必须是 JSON 对象'],
    ['plan without rooms', { plans: [{}] }, 'plans[0].rooms 缺失'],
    ['non-object rooms', { plans: [{ rooms: [] }] }, 'plans[0].rooms 必须是 JSON 对象'],
    ['non-array facility rooms', { plans: [{ rooms: { manufacture: {} } }] }, 'rooms.manufacture 必须是数组'],
    ['non-object room entry', { plans: [{ rooms: { manufacture: ['x'] } }] }, 'rooms.manufacture[0] 必须是 JSON 对象'],
    ['non-string title', { title: 42, plans: [{ rooms: {} }] }, '排班表.title 必须是字符串'],
    ['non-boolean skip', { plans: [{ rooms: { control: [{ skip: 'yes' }] } }] }, 'skip 必须是布尔值'],
    ['non-boolean autofill', { plans: [{ rooms: { control: [{ autofill: 1 }] } }] }, 'autofill 必须是布尔值'],
    ['non-boolean sort', { plans: [{ rooms: { manufacture: [{ sort: 'true' }] } }] }, 'sort 必须是布尔值'],
    ['non-array operators', { plans: [{ rooms: { control: [{ operators: '夕' }] } }] }, 'operators 必须是字符串数组'],
    ['non-string candidate', { plans: [{ rooms: { control: [{ candidates: ['夕', 1] }] } }] }, 'candidates 必须是字符串数组'],
    ['non-string operatorsA', { plans: [{ rooms: { training: [{ operatorsA: [1] }] } }] }, 'operatorsA 必须是字符串数组'],
    ['non-string product', { plans: [{ rooms: { manufacture: [{ product: 1 }] } }] }, 'product 必须是字符串'],
    ['non-array period', { plans: [{ period: '22:00', rooms: {} }] }, 'period 必须是数组'],
    ['period entry with one time', { plans: [{ period: [['22:00']], rooms: {} }] }, '两元素数组'],
    ['period entry with invalid clock', { plans: [{ period: [['25:00', '26:00']], rooms: {} }] }, 'hh:mm 格式'],
    ['non-number duration', { plans: [{ duration: '360', rooms: {} }] }, 'duration 必须是数字'],
    ['non-object Fiammetta', { plans: [{ Fiammetta: 'on', rooms: {} }] }, 'Fiammetta 必须是 JSON 对象'],
    ['non-boolean Fiammetta enable', { plans: [{ Fiammetta: { enable: 'true' }, rooms: {} }] }, 'Fiammetta.enable 必须是布尔值'],
    ['invalid Fiammetta order', { plans: [{ Fiammetta: { order: 'after' }, rooms: {} }] }, 'Fiammetta.order'],
    ['non-object drones', { plans: [{ drones: [], rooms: {} }] }, 'drones 必须是 JSON 对象'],
    ['invalid drones room', { plans: [{ drones: { room: 'power' }, rooms: {} }] }, 'drones.room'],
    ['drones index out of range', { plans: [{ drones: { index: 6 }, rooms: {} }] }, 'drones.index 必须是 1-5'],
    ['non-array groups', { plans: [{ groups: {}, rooms: {} }] }, 'groups 必须是数组'],
    ['group without name', { plans: [{ groups: [{}], rooms: {} }] }, 'groups[0].name 必须是字符串'],
    ['group without operators', { plans: [{ groups: [{ name: '古+银' }], rooms: {} }] }, 'groups[0].operators 必须是字符串数组']
  ];

  for (const [label, document, expectedMessage] of rejectedCases) {
    it(`rejects ${label}`, () => {
      const message = validateInfrastScheduleDocument(document);
      assert.ok(message, `expected a validation message for ${label}`);
      assert.ok(
        message.includes(expectedMessage),
        `expected "${message}" to include "${expectedMessage}"`
      );
    });
  }
});

describe('infrast schedule service', () => {
  let rootDir: string;
  let service: InfrastScheduleService;

  beforeEach(async () => {
    rootDir = await makeTempDir('la-pluma-infrast-schedule-');
    service = createInfrastScheduleService({ rootDir });
  });

  afterEach(async () => {
    let dir = tempDirs.pop();
    while (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = tempDirs.pop();
    }
  });

  it('round-trips a real user schedule and lists it with its summary', async () => {
    const document = realUserScheduleFixture();

    const saved = await service.save('243_layout.json', document);
    assert.deepEqual(saved, { name: '243_layout.json', planCount: 2 });

    const readResult = await service.read('243_layout.json');
    assert.equal(readResult.name, '243_layout.json');
    assert.deepEqual(readResult.document, document);

    const raw = await readFile(join(rootDir, '243_layout.json'), 'utf-8');
    assert.ok(raw.startsWith('{\n  "'), 'saved document should be pretty printed');
    assert.ok(raw.includes('\n  "plans"'), 'saved document should contain the plans array');
    assert.deepEqual(JSON.parse(raw), document);

    const list = await service.list();
    assert.equal(list.directory, rootDir);
    assert.equal(list.schedules.length, 1);
    const [summary] = list.schedules;
    assert.equal(summary.name, '243_layout.json');
    assert.equal(summary.title, '243-高配3队简化');
    assert.equal(summary.planCount, 2);
    assert.equal(summary.valid, true);
    assert.match(summary.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('round-trips a minimal document without touching optional structure', async () => {
    const document = minimalScheduleDocument();

    assert.deepEqual(await service.save('minimal.json', document), { name: 'minimal.json', planCount: 1 });
    assert.deepEqual((await service.read('minimal.json')).document, document);
    assert.deepEqual(JSON.parse(await readFile(join(rootDir, 'minimal.json'), 'utf-8')), document);
  });

  it('keeps the three facility states and untouched rooms byte-for-byte', async () => {
    const document = {
      plans: [{
        rooms: {
          control: [{}],
          manufacture: [],
          training: [{ operatorsA: [], operatorsB: [] }]
        }
      }]
    };

    await service.save('states.json', document);
    assert.deepEqual((await service.read('states.json')).document, document);

    const raw = await readFile(join(rootDir, 'states.json'), 'utf-8');
    const stored = requireRecord(JSON.parse(raw), 'stored document');
    const plan = requireRecord((stored.plans as unknown[])[0], 'stored plan');
    assert.deepEqual(Object.keys(requireRecord(plan.rooms, 'stored rooms')), ['control', 'manufacture', 'training']);
    assert.ok(!raw.includes('"skip"'), 'missing skip must not be materialized as a default');
    assert.ok(!raw.includes('"autofill"'), 'missing autofill must not be materialized as a default');
    assert.ok(!raw.includes('"sort"'), 'missing sort must not be materialized as a default');
  });

  it('preserves product strings outside the documented editor list', async () => {
    const document = {
      plans: [{
        rooms: {
          manufacture: [{ operators: ['芬'], product: 'Future Product' }],
          trading: [{ product: '未来贸易产物' }]
        }
      }]
    };

    await service.save('future-product.json', document);
    assert.deepEqual((await service.read('future-product.json')).document, document);
    assert.deepEqual((await service.list()).schedules.map(entry => entry.valid), [true]);
  });

  it('preserves the training two-slot fields and the ineffective recycle product', async () => {
    const document = {
      plans: [{
        rooms: {
          training: [{ operatorsA: ['杜宾'], operatorsB: ['银灰'] }],
          recycle: [{ operators: ['芬', '克洛丝'], product: 'LMD' }]
        }
      }]
    };

    await service.save('training-recycle.json', document);
    assert.deepEqual((await service.read('training-recycle.json')).document, document);
    const raw = await readFile(join(rootDir, 'training-recycle.json'), 'utf-8');
    assert.ok(raw.includes('"operatorsA"'));
    assert.ok(raw.includes('"operatorsB"'));
    assert.ok(raw.includes('"product": "LMD"'));
  });

  it('supports nested and absolute-in-root names with canonical relative results', async () => {
    const document = realUserScheduleFixture();
    await mkdir(join(rootDir, 'nested'), { recursive: true });

    const nestedSave = await service.save('nested/plan.json', document);
    assert.equal(nestedSave.name, 'nested/plan.json');

    const absoluteSave = await service.save(join(rootDir, 'absolute.json'), document);
    assert.equal(absoluteSave.name, 'absolute.json');

    assert.deepEqual((await service.read(join(rootDir, 'nested', 'plan.json'))).document, document);
    assert.equal((await service.read('absolute.json')).name, 'absolute.json');

    const list = await service.list();
    assert.deepEqual(list.schedules.map(entry => entry.name), ['absolute.json', 'nested/plan.json']);
  });

  it('lists recursively with a bounded depth and marks invalid files', async () => {
    const validDocument = minimalScheduleDocument();
    await mkdir(join(rootDir, 'a/b/c/d/e'), { recursive: true });
    await writeFile(join(rootDir, 'a/b/c/d/plan.json'), JSON.stringify({ ...validDocument, title: '深一层' }));
    await writeFile(join(rootDir, 'a/b/c/d/e/too-deep.json'), JSON.stringify(validDocument));
    await mkdir(join(rootDir, 'directory.json'));
    await expectServiceError(() => service.read('directory.json'), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.notFound,
      statusCode: 404
    });

    await writeFile(join(rootDir, 'broken.json'), '{"plans": [');
    await writeFile(join(rootDir, 'invalid-content.json'), JSON.stringify({ plans: [] }));
    await writeFile(join(rootDir, 'ignored.txt'), JSON.stringify(validDocument));
    await writeFile(join(rootDir, '.hidden.json'), JSON.stringify(validDocument));

    const list = await service.list();
    assert.deepEqual(list.schedules.map(entry => entry.name), [
      'a/b/c/d/plan.json',
      'broken.json',
      'invalid-content.json'
    ]);
    const byName = new Map(list.schedules.map(entry => [entry.name, entry]));
    assert.equal(byName.get('a/b/c/d/plan.json')?.valid, true);
    assert.equal(byName.get('a/b/c/d/plan.json')?.title, '深一层');
    assert.equal(byName.get('broken.json')?.valid, false);
    assert.equal(byName.get('broken.json')?.title, null);
    assert.equal(byName.get('broken.json')?.planCount, 0);
    assert.equal(byName.get('invalid-content.json')?.valid, false);
    assert.equal(byName.get('invalid-content.json')?.planCount, 0);
  });

  it('returns an empty list for a missing root and creates it on save', async () => {
    const missingRoot = join(rootDir, 'missing', 'infrast');
    const missingService = createInfrastScheduleService({ rootDir: missingRoot });

    assert.deepEqual(await missingService.list(), { directory: missingRoot, schedules: [] });
    await expectServiceError(() => missingService.read('plan.json'), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.notFound,
      statusCode: 404
    });

    const saved = await missingService.save('plan.json', minimalScheduleDocument());
    assert.deepEqual(saved, { name: 'plan.json', planCount: 1 });
    assert.deepEqual((await missingService.read('plan.json')).document, minimalScheduleDocument());
  });

  it('rejects unsafe names and path escapes without writing outside the root', async () => {
    const outsideDir = await makeTempDir('la-pluma-infrast-outside-');
    const outsideFile = join(outsideDir, 'escape.json');

    const unsafeNames: unknown[] = [
      42,
      null,
      '',
      '   ',
      '../escape.json',
      'nested/../../escape.json',
      outsideFile,
      '/etc/passwd',
      'notes.txt',
      'bad\u0000name.json',
      'sub\\plan.json',
      'C:/plan.json',
      'plan.json/../other.json'
    ];

    for (const name of unsafeNames) {
      await expectServiceError(() => service.read(name), {
        code: INFRASTRUCT_SCHEDULE_ERROR_CODES.invalid,
        statusCode: 400
      });
    }
    await expectServiceError(() => service.save('../escape.json', minimalScheduleDocument()), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.invalid,
      statusCode: 400
    });

    await assert.rejects(readFile(outsideFile, 'utf-8'));
    assert.deepEqual((await service.list()).schedules, []);
  });

  it('rejects symlinked files and directories that escape the root', {
    skip: process.platform === 'win32' ? 'Windows 创建符号链接需要额外权限' : false
  }, async () => {
    const outsideDir = await makeTempDir('la-pluma-infrast-outside-');
    const outsideFile = join(outsideDir, 'secret.json');
    await writeFile(outsideFile, JSON.stringify({ plans: [{ rooms: {} }] }));
    await symlink(outsideFile, join(rootDir, 'linked.json'));
    await symlink(outsideDir, join(rootDir, 'linked-dir'));

    await expectServiceError(() => service.read('linked.json'), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.invalid,
      statusCode: 400
    });
    await expectServiceError(() => service.save('linked.json', minimalScheduleDocument()), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.invalid,
      statusCode: 400
    });
    await expectServiceError(() => service.save('linked-dir/new.json', minimalScheduleDocument()), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.invalid,
      statusCode: 400
    });

    assert.deepEqual(JSON.parse(await readFile(outsideFile, 'utf-8')), { plans: [{ rooms: {} }] });
    await assert.rejects(readFile(join(outsideDir, 'new.json'), 'utf-8'));

    await writeFile(join(rootDir, 'real.json'), JSON.stringify(minimalScheduleDocument()));
    await symlink(join(rootDir, 'real.json'), join(rootDir, 'alias.json'));
    assert.deepEqual((await service.read('alias.json')).document, minimalScheduleDocument());
    assert.deepEqual((await service.list()).schedules.map(entry => entry.name), ['real.json']);
  });

  it('reports missing files and broken JSON distinctly', async () => {
    await expectServiceError(() => service.read('missing.json'), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.notFound,
      statusCode: 404,
      retryable: false
    });

    await mkdir(join(rootDir, 'directory.json'));
    await expectServiceError(() => service.read('directory.json'), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.notFound,
      statusCode: 404
    });

    await writeFile(join(rootDir, 'broken.json'), '{"plans": [');
    const error = await expectServiceError(() => service.read('broken.json'), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.invalid,
      statusCode: 400
    });
    assert.match(String(error.message), /不是有效的 JSON/);
  });

  it('validates the document before writing anything', async () => {
    const error = await expectServiceError(
      () => service.save('invalid.json', { plans: [] }),
      { code: INFRASTRUCT_SCHEDULE_ERROR_CODES.invalid, statusCode: 400 }
    );
    assert.match(String(error.message), /plans 不能为空/);
    await assert.rejects(readFile(join(rootDir, 'invalid.json'), 'utf-8'));
  });

  it('maps filesystem failures to a retryable IO error', async () => {
    const document = minimalScheduleDocument();
    await service.save('existing.json', document);

    const failingReadService = createInfrastScheduleService({
      rootDir,
      fileSystem: {
        readTextFile: async () => {
          throw permissionError();
        }
      }
    });
    const readError = await expectServiceError(() => failingReadService.read('existing.json'), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.ioFailed,
      statusCode: 500,
      retryable: true
    });
    assert.match(String(readError.message), /读取基建排班文件失败/);

    const failingListService = createInfrastScheduleService({
      rootDir,
      fileSystem: {
        listDirectory: async () => {
          throw permissionError();
        }
      }
    });
    const listError = await expectServiceError(() => failingListService.list(), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.ioFailed,
      statusCode: 500,
      retryable: true
    });
    assert.match(String(listError.message), /读取基建排班目录失败/);

    const failingWriteService = createInfrastScheduleService({
      rootDir,
      fileSystem: {
        writeJson: async () => {
          throw permissionError();
        }
      }
    });
    const writeError = await expectServiceError(() => failingWriteService.save('other.json', document), {
      code: INFRASTRUCT_SCHEDULE_ERROR_CODES.ioFailed,
      statusCode: 500,
      retryable: true
    });
    assert.match(String(writeError.message), /保存基建排班文件失败/);
  });

  it('marks unreadable files as invalid instead of failing the whole list', async () => {
    await service.save('readable.json', minimalScheduleDocument());
    await service.save('unreadable.json', minimalScheduleDocument());

    const unreadablePath = join(rootDir, 'unreadable.json');
    const partialService = createInfrastScheduleService({
      rootDir,
      fileSystem: {
        readTextFile: async filePath => {
          if (filePath === unreadablePath) throw permissionError();
          return readFile(filePath, 'utf-8');
        }
      }
    });

    const list = await partialService.list();
    const byName = new Map(list.schedules.map(entry => [entry.name, entry]));
    assert.equal(byName.get('readable.json')?.valid, true);
    assert.equal(byName.get('unreadable.json')?.valid, false);
    assert.equal(byName.get('unreadable.json')?.title, null);
  });
});
