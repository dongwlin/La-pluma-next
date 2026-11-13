import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveAppPaths } from '../../config/runtimeConfig.ts';
import {
  COPILOT_FILE_IMPORT_DIR,
  COPILOT_FILE_MAX_BYTES,
  CopilotFileInvalidError,
  saveCopilotFile,
  sanitizeCopilotFileName,
  validateManagedCopilotFileName
} from '../copilotFileService.ts';
import type { CopilotFileInvalidReason } from '../copilotFileService.ts';

const UUID_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

async function makeDataDir(t: TestContext): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-file-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function validContent(stageName = '1-7'): string {
  return JSON.stringify({
    stage_name: stageName,
    opers: [{ name: '测试干员', skill: 1 }],
    groups: [{ name: '默认', opers: ['测试干员'] }]
  });
}

async function assertInvalid(
  promise: Promise<unknown>,
  reason: CopilotFileInvalidReason
): Promise<CopilotFileInvalidError> {
  return promise.then(
    () => assert.fail('expected CopilotFileInvalidError'),
    (error: unknown) => {
      assert.ok(error instanceof CopilotFileInvalidError);
      assert.equal(error.reason, reason);
      return error;
    }
  );
}

describe('sanitizeCopilotFileName', () => {
  it('缺失或非字符串名称回退到 copilot.json', () => {
    assert.equal(sanitizeCopilotFileName(undefined), 'copilot.json');
    assert.equal(sanitizeCopilotFileName(''), 'copilot.json');
    assert.equal(sanitizeCopilotFileName('   '), 'copilot.json');
    assert.equal(sanitizeCopilotFileName(42), 'copilot.json');
    assert.equal(sanitizeCopilotFileName('..'), 'copilot.json');
  });

  it('去掉路径成分且只保留安全字符', () => {
    assert.equal(sanitizeCopilotFileName('../../etc/passwd'), 'passwd.json');
    assert.equal(sanitizeCopilotFileName(String.raw`C:\Users\me\作业 v2.JSON`), '作业_v2.json');
    assert.equal(sanitizeCopilotFileName('/var/tmp/evil<script>.json'), 'evil_script_.json');
    assert.equal(sanitizeCopilotFileName('bad name!.json'), 'bad_name_.json');
  });

  it('统一以 .json 结尾且拒绝路径分隔符', () => {
    for (const name of ['作业', '作业.txt', '../../作业.json', 'a/b/c']) {
      const sanitized = sanitizeCopilotFileName(name);
      assert.ok(sanitized.endsWith('.json'));
      assert.ok(!sanitized.includes('/'));
      assert.ok(!sanitized.includes('\\'));
      assert.ok(!sanitized.includes('..'));
    }
  });
});

describe('legacy managed Copilot paths', () => {
  const { serverRoot } = resolveAppPaths();
  const legacyImportDir = resolve(serverRoot, '../..', 'server', 'data', COPILOT_FILE_IMPORT_DIR);

  it('preserves a stored path in requests and reads the import from the migrated data directory', async t => {
    const root = await makeDataDir(t);
    const sourceDir = join(root, 'apps', 'server', 'src');
    const serviceFile = join(sourceDir, 'services/copilotFileService.ts');
    await Promise.all(['config/runtimeConfig.ts', 'utils/fileHelper.ts', 'services/copilotFileService.ts'].map(async file => {
      const destination = join(sourceDir, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(serverRoot, 'src', file), destination);
    }));
    const service: typeof import('../copilotFileService.ts') = await import(pathToFileURL(serviceFile).href);
    const content = validContent();
    const saved = await service.saveCopilotFile({ content });
    const legacyPath = join(root, 'server', 'data', COPILOT_FILE_IMPORT_DIR, basename(saved.path));

    assert.equal(service.validateManagedCopilotFileName(legacyPath), legacyPath);
    const imported = await service.readManagedCopilotFile(legacyPath);
    assert.equal(imported.stageName, '1-7');
    assert.deepEqual(imported.content, JSON.parse(content));
  });

  it('rejects paths outside the legacy import directory and with explicit data directory overrides', async t => {
    const dataDir = await makeDataDir(t);
    assert.throws(() => validateManagedCopilotFileName(join(legacyImportDir, 'a.json'), { dataDir }), {
      reason: 'filename_outside_import_dir'
    });
    assert.throws(() => validateManagedCopilotFileName(`${legacyImportDir}-other${sep}a.json`), {
      reason: 'filename_outside_import_dir'
    });
    assert.throws(() => validateManagedCopilotFileName(`${legacyImportDir}${sep}..${sep}a.json`), {
      reason: 'filename_traversal'
    });
  });
});

describe('saveCopilotFile', () => {
  it('写入受管目录并返回绝对路径、展示名与字节数', async t => {
    const dataDir = await makeDataDir(t);
    const content = validContent('H9-6');
    const result = await saveCopilotFile({ name: 'H9-6.json', content }, { dataDir });
    const importDir = join(dataDir, COPILOT_FILE_IMPORT_DIR);

    assert.equal(result.name, 'H9-6.json');
    assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(dirname(result.path), importDir);
    assert.match(basename(result.path), UUID_FILE_NAME);
    assert.equal(await readFile(result.path, 'utf-8'), content);
    assert.equal((await stat(result.path)).isFile(), true);
    if (process.platform !== 'win32') {
      assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    }
  });

  it('展示名清洗后不改变受管目录内的落盘路径', async t => {
    const dataDir = await makeDataDir(t);
    const result = await saveCopilotFile({
      name: '../../etc/passwd',
      content: validContent()
    }, { dataDir });

    assert.equal(result.name, 'passwd.json');
    assert.equal(dirname(result.path), join(dataDir, COPILOT_FILE_IMPORT_DIR));
    assert.match(basename(result.path), UUID_FILE_NAME);
  });

  it('目录不存在时创建 copilot-imports', async t => {
    const dataDir = join(await makeDataDir(t), 'nested', 'appdata');
    const result = await saveCopilotFile({ content: validContent() }, { dataDir });
    const importDir = join(dataDir, COPILOT_FILE_IMPORT_DIR);

    assert.equal((await stat(importDir)).isDirectory(), true);
    assert.equal(dirname(result.path), importDir);
    assert.equal(result.name, 'copilot.json');
  });

  it('每次写入使用独立的随机文件名', async t => {
    const dataDir = await makeDataDir(t);
    const first = await saveCopilotFile({ content: validContent() }, { dataDir });
    const second = await saveCopilotFile({ content: validContent() }, { dataDir });

    assert.notEqual(first.path, second.path);
    assert.deepEqual((await readdir(join(dataDir, COPILOT_FILE_IMPORT_DIR))).sort(), [
      basename(first.path),
      basename(second.path)
    ].sort());
  });

  it('接受恰好 2 MiB 的内容并拒绝超出一个字节的内容', async t => {
    const dataDir = await makeDataDir(t);
    const emptyContent = JSON.stringify({ stage_name: '1-7', pad: '' });
    const padding = 'x'.repeat(COPILOT_FILE_MAX_BYTES - Buffer.byteLength(emptyContent, 'utf8'));
    const atLimit = JSON.stringify({ stage_name: '1-7', pad: padding });

    assert.equal(Buffer.byteLength(atLimit, 'utf8'), COPILOT_FILE_MAX_BYTES);
    const saved = await saveCopilotFile({ content: atLimit }, { dataDir });
    assert.equal(saved.bytes, COPILOT_FILE_MAX_BYTES);
    await assertInvalid(
      saveCopilotFile({ content: `${atLimit} ` }, { dataDir }),
      'content_too_large'
    );
  });

  it('拒绝非对象请求体', async t => {
    const dataDir = await makeDataDir(t);
    await assertInvalid(saveCopilotFile(null, { dataDir }), 'body_not_object');
    await assertInvalid(saveCopilotFile([], { dataDir }), 'body_not_object');
    await assertInvalid(saveCopilotFile('{"stage_name":"1-7"}', { dataDir }), 'body_not_object');
  });

  it('拒绝非字符串内容', async t => {
    const dataDir = await makeDataDir(t);
    await assertInvalid(saveCopilotFile({ content: { stage_name: '1-7' } }, { dataDir }), 'content_not_string');
    await assertInvalid(saveCopilotFile({ content: 42 }, { dataDir }), 'content_not_string');
    await assertInvalid(saveCopilotFile({}, { dataDir }), 'content_not_string');
  });

  it('拒绝无法解析或不是对象的 JSON', async t => {
    const dataDir = await makeDataDir(t);
    await assertInvalid(
      saveCopilotFile({ content: '{ "stage_name": "1-7"' }, { dataDir }),
      'content_invalid_json'
    );
    await assertInvalid(saveCopilotFile({ content: '[]' }, { dataDir }), 'content_not_object');
    await assertInvalid(saveCopilotFile({ content: '"1-7"' }, { dataDir }), 'content_not_object');
    await assertInvalid(saveCopilotFile({ content: 'null' }, { dataDir }), 'content_not_object');
  });

  it('要求 stage_name 为非空字符串', async t => {
    const dataDir = await makeDataDir(t);
    await assertInvalid(saveCopilotFile({ content: '{"opers":[]}' }, { dataDir }), 'stage_name_invalid');
    await assertInvalid(saveCopilotFile({ content: '{"stage_name":"   "}' }, { dataDir }), 'stage_name_invalid');
    await assertInvalid(saveCopilotFile({ content: '{"stage_name":42}' }, { dataDir }), 'stage_name_invalid');
    await assertInvalid(saveCopilotFile({ content: '{"stage_name":null}' }, { dataDir }), 'stage_name_invalid');
  });

  it('非法请求不创建受管目录也不落盘', async t => {
    const dataDir = await makeDataDir(t);
    const importDir = join(dataDir, COPILOT_FILE_IMPORT_DIR);

    await assertInvalid(saveCopilotFile({ content: '{not json' }, { dataDir }), 'content_invalid_json');
    await assertInvalid(saveCopilotFile({ content: '{"stage_name":""}' }, { dataDir }), 'stage_name_invalid');

    await assert.rejects(readdir(importDir), { code: 'ENOENT' });
  });

  it('不把文件内容写入日志或错误信息', async t => {
    const dataDir = await makeDataDir(t);
    const marker = 'SECRET-CONTENT-MARKER';
    const captured: string[] = [];
    const original = {
      log: console.log,
      warn: console.warn,
      error: console.error
    };
    const capture = (...args: Parameters<typeof console.log>): void => {
      captured.push(args.map(value => String(value)).join(' '));
    };
    console.log = capture;
    console.warn = capture;
    console.error = capture;

    try {
      await saveCopilotFile({ content: JSON.stringify({ stage_name: marker }) }, { dataDir });
      const error = await assertInvalid(
        saveCopilotFile({ content: JSON.stringify({ stage_name: '', marker }) }, { dataDir }),
        'stage_name_invalid'
      );
      assert.ok(!error.message.includes(marker));
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }

    assert.ok(!captured.some(line => line.includes(marker)));
  });
});
