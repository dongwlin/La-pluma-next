import assert from 'node:assert/strict';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { after, describe, it } from 'node:test';
import { createLaPlumaApp } from '../../app.ts';
import { apiErrorHandler } from '../../utils/apiHelper.ts';
import { CopilotFileInvalidError } from '../../services/copilotFileService.ts';
import type {
  CopilotFileInput,
  CopilotFileResult
} from '../../services/copilotFileService.ts';
import { createCopilotFilesRouter } from '../copilotFiles.ts';
import {
  closeHttpServers,
  postJson,
  readError,
  readSuccess,
  silenceLoggers,
  startHttpServer
} from '../../__tests__/support/httpTestHelpers.ts';

const servers: Server[] = [];

silenceLoggers(['Api']);

after(async () => {
  await closeHttpServers(servers);
});

function createRouterApp(saveFile: (input: CopilotFileInput) => Promise<CopilotFileResult>): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/copilot-files', createCopilotFilesRouter({ saveFile }));
  app.use(apiErrorHandler);
  return app;
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/copilot-files`;
}

describe('POST /api/copilot-files', () => {
  it('保存成功返回统一 envelope 与保存结果', async () => {
    const calls: CopilotFileInput[] = [];
    const saved: CopilotFileResult = {
      path: '/managed/copilot-imports/6f9619ff-8b86-4d01-b42d-00cf4fc964ff.json',
      name: '作业.json',
      bytes: 26
    };
    const app = createRouterApp(async input => {
      calls.push(input);
      return saved;
    });
    const port = await startHttpServer(app, servers);

    const response = await postJson(baseUrl(port), {
      name: '作业.json',
      content: '{"stage_name":"1-7"}'
    });

    assert.equal(response.status, 200);
    const body = await readSuccess<CopilotFileResult>(response);
    assert.deepEqual(body.data, saved);
    assert.equal(body.message, '作业文件已保存');
    assert.equal(body.meta.dryRun, false);
    assert.deepEqual(calls, [{ name: '作业.json', content: '{"stage_name":"1-7"}' }]);
  });

  it('非对象请求体返回 400 COPILOT_FILE_INVALID 且不调用保存', async () => {
    let called = false;
    const app = createRouterApp(async () => {
      called = true;
      return { path: '/tmp/x.json', name: 'copilot.json', bytes: 1 };
    });
    const port = await startHttpServer(app, servers);

    const response = await postJson(baseUrl(port), []);

    assert.equal(response.status, 400);
    const body = await readError(response);
    assert.equal(body.error.code, 'COPILOT_FILE_INVALID');
    assert.equal(body.error.details.reason, 'body_not_object');
    assert.equal(called, false);
  });

  it('校验失败映射为 400 且不回显文件内容', async () => {
    const app = createRouterApp(async () => {
      throw new CopilotFileInvalidError('content_invalid_json', '作业文件不是有效的 JSON');
    });
    const port = await startHttpServer(app, servers);
    const marker = 'SECRET-CONTENT-MARKER';

    const response = await postJson(baseUrl(port), {
      content: `{ "stage_name": "1-7", "marker": "${marker}"`
    });
    const text = await response.clone().text();

    assert.equal(response.status, 400);
    assert.ok(!text.includes(marker));
    const body = await readError(response);
    assert.equal(body.success, false);
    assert.equal(body.message, '作业文件不是有效的 JSON');
    assert.equal(body.error.code, 'COPILOT_FILE_INVALID');
    assert.equal(body.error.details.reason, 'content_invalid_json');
    assert.equal(body.error.retryable, false);
  });

  it('非校验错误按内部错误返回 500', async () => {
    const app = createRouterApp(async () => {
      throw new Error('磁盘写入失败');
    });
    const port = await startHttpServer(app, servers);

    const response = await postJson(baseUrl(port), { content: '{"stage_name":"1-7"}' });

    assert.equal(response.status, 500);
    const body = await readError(response);
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
    assert.ok(!body.message.includes('磁盘写入失败'));
  });
});

describe('/api/copilot-files app 挂载', () => {
  it('挂载到 /api 命名空间并返回业务错误 envelope', async () => {
    const app = createLaPlumaApp({ env: {} });
    const port = await startHttpServer(app, servers);

    const response = await postJson(baseUrl(port), []);

    assert.equal(response.status, 400);
    const body = await readError(response);
    assert.equal(body.error.code, 'COPILOT_FILE_INVALID');
    assert.equal(body.error.details.reason, 'body_not_object');
    assert.ok(typeof body.meta.requestId === 'string');
  });

  it('非法 JSON 请求体返回 400 AGENT_REQUEST_BODY_INVALID', async () => {
    const app = createLaPlumaApp({ env: {} });
    const port = await startHttpServer(app, servers);

    const response = await fetch(baseUrl(port), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ "content": '
    });

    assert.equal(response.status, 400);
    const body = await readError(response);
    assert.equal(body.error.code, 'AGENT_REQUEST_BODY_INVALID');
  });

  it('超过 2 MiB 的请求体返回 413 AGENT_REQUEST_BODY_TOO_LARGE', async () => {
    const app = createLaPlumaApp({ env: {} });
    const port = await startHttpServer(app, servers);

    const response = await postJson(baseUrl(port), {
      content: 'x'.repeat(2 * 1024 * 1024 + 1)
    });

    assert.equal(response.status, 413);
    const body = await readError(response);
    assert.equal(body.error.code, 'AGENT_REQUEST_BODY_TOO_LARGE');
  });
});
