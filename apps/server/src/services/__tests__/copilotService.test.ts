import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadParadoxOperators } from '../copilotService.ts';
import type { CopilotJsonResponse, CopilotServicePorts } from '../copilotService.ts';

let rootDir: string;

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'la-pluma-copilot-'));
});

after(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function forbiddenRequest(ports: CopilotServicePorts = {}): CopilotServicePorts {
  return {
    ...ports,
    requestJson: async () => {
      throw new Error('unexpected outbound copilot request');
    }
  };
}

describe('loadParadoxOperators', () => {
  it('reads the cached operator list', async () => {
    const paradoxOperatorsPath = join(rootDir, 'paradox-cached.json');
    await writeFile(paradoxOperatorsPath, JSON.stringify([
      { id: 'char_1001_amiya', name: '阿米娅', stage_id: 'main_01-07', stage_name: '坍塌' }
    ]), 'utf-8');

    const operators = await loadParadoxOperators(forbiddenRequest({ paradoxOperatorsPath }));

    assert.deepEqual(operators, [
      { id: 'char_1001_amiya', name: '阿米娅', stage_id: 'main_01-07', stage_name: '坍塌' }
    ]);
  });

  it('drops malformed cache entries instead of failing the whole list', async () => {
    const paradoxOperatorsPath = join(rootDir, 'paradox-partial.json');
    await writeFile(paradoxOperatorsPath, JSON.stringify([
      { id: 'char_1001_amiya', name: '阿米娅', stage_id: 'main_01-07', stage_name: '坍塌' },
      { id: 'char_2002_missing_stage', name: '无悖论' },
      'not-an-entry'
    ]), 'utf-8');

    const operators = await loadParadoxOperators(forbiddenRequest({ paradoxOperatorsPath }));

    assert.deepEqual(operators.map(operator => operator.id), ['char_1001_amiya']);
  });

  it('fetches and maps the upstream tables when no cache exists', async () => {
    const handlers: Record<string, CopilotJsonResponse> = {
      'handbook_info_table.json': {
        data: {
          handbookStageData: {
            char_1001_amiya: { stageId: 'main_01-07', name: '坍塌' },
            char_2002_kalts: { code: 'main_02-01' },
            char_3003_no_stage: { name: '没有关卡' }
          },
          handbookDict: { char_2002_kalts: { infoName: '凯尔希（字典）' } }
        }
      },
      'character_table.json': {
        data: { char_1001_amiya: { name: '阿米娅' }, char_3003_no_stage: { name: '无关卡干员' } }
      }
    };

    const operators = await loadParadoxOperators({
      paradoxOperatorsPath: join(rootDir, 'no-cache.json'),
      requestJson: async url => {
        const name = url.split('/').pop() || '';
        assert.ok(handlers[name], `unexpected upstream url: ${url}`);
        return handlers[name];
      }
    });

    assert.deepEqual(operators, [
      { id: 'char_1001_amiya', name: '阿米娅', stage_id: 'main_01-07', stage_name: '坍塌' },
      { id: 'char_2002_kalts', name: '凯尔希（字典）', stage_id: 'main_02-01', stage_name: '' }
    ]);
  });

  it('treats a non-array cache as a cache miss', async () => {
    const paradoxOperatorsPath = join(rootDir, 'paradox-object.json');
    await writeFile(paradoxOperatorsPath, JSON.stringify({ operators: [] }), 'utf-8');

    const requested: string[] = [];
    const operators = await loadParadoxOperators({
      paradoxOperatorsPath,
      requestJson: async url => {
        requested.push(url);
        return { data: {} };
      }
    });

    assert.deepEqual(operators, []);
    assert.equal(requested.length, 2);
  });

  it('returns an empty list when the upstream payloads are malformed', async () => {
    const operators = await loadParadoxOperators({
      paradoxOperatorsPath: join(rootDir, 'no-cache-malformed.json'),
      requestJson: async () => ({ data: null })
    });

    assert.deepEqual(operators, []);
  });

  it('propagates read failures for a cache file that is not valid JSON', async () => {
    const paradoxOperatorsPath = join(rootDir, 'paradox-broken.json');
    await writeFile(paradoxOperatorsPath, '{ not json', 'utf-8');

    await assert.rejects(
      () => loadParadoxOperators(forbiddenRequest({ paradoxOperatorsPath })),
      SyntaxError
    );
  });
});
