/**
 * apiHelper 工具类测试
 * 运行: node --test server/utils/__tests__/apiHelper.test.js
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { createServer } from 'node:http';
import {
  successResponse,
  errorResponse,
  validateRequired,
  safeJsonParse,
  agentError,
  sendError,
  asyncHandler,
  apiErrorHandler
} from '../apiHelper.js';

describe('apiHelper', () => {
  describe('successResponse', () => {
    it('应该返回成功响应格式', () => {
      const result = successResponse({ id: 1 }, '操作成功');
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, '操作成功');
      assert.deepStrictEqual(result.data, { id: 1 });
    });

    it('应该使用默认消息', () => {
      const result = successResponse({ id: 1 });
      
      assert.strictEqual(result.message, '操作成功');
    });
  });

  describe('errorResponse', () => {
    it('应该返回错误响应格式', () => {
      const error = new Error('测试错误');
      const result = errorResponse(error, '操作失败');
      
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.message, '操作失败');
      assert.deepStrictEqual(result.error, {
        code: 'AGENT_INTERNAL_ERROR',
        details: {},
        retryable: false
      });
      assert.deepStrictEqual(result.meta, {
        requestId: null,
        dryRun: false
      });
    });

    it('应该使用错误消息作为默认消息', () => {
      const error = new Error('测试错误');
      const result = errorResponse(error);
      
      assert.strictEqual(result.message, '测试错误');
    });
  });

  describe('validateRequired', () => {
    it('应该通过验证', () => {
      const data = { name: 'test', value: 123 };
      
      assert.doesNotThrow(() => {
        validateRequired(data, ['name', 'value']);
      });
    });

    it('应该抛出缺少参数错误', () => {
      const data = { name: 'test' };
      
      assert.throws(() => {
        validateRequired(data, ['name', 'value']);
      }, /缺少必需参数: value/);
    });

    it('应该抛出多个缺少参数错误', () => {
      const data = {};
      
      assert.throws(() => {
        validateRequired(data, ['name', 'value']);
      }, /缺少必需参数: name, value/);
    });
  });

  describe('safeJsonParse', () => {
    it('应该成功解析 JSON', () => {
      const result = safeJsonParse('{"key":"value"}');

      assert.deepStrictEqual(result, { key: 'value' });
    });

    it('应该返回默认值当解析失败', () => {
      const result = safeJsonParse('invalid json', { default: true });

      assert.deepStrictEqual(result, { default: true });
    });

    it('应该返回 null 当没有默认值', () => {
      const result = safeJsonParse('invalid json');

      assert.strictEqual(result, null);
    });
  });

  describe('sendError', () => {
    function createResponse() {
      return {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        }
      };
    }

    it('应该把范围外的错误状态归一到 500', () => {
      const res = createResponse();
      sendError(res, null, Object.assign(new Error('意外跳转'), { statusCode: 302 }));

      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(res.body.error.code, 'AGENT_INTERNAL_ERROR');
    });

    it('应该保留 400-599 范围内的业务状态', () => {
      const res = createResponse();
      sendError(res, null, agentError('AGENT_RUN_NOT_FOUND', '未找到', { statusCode: 404 }));

      assert.strictEqual(res.statusCode, 404);
      assert.strictEqual(res.body.error.code, 'AGENT_RUN_NOT_FOUND');
    });
  });

  describe('asyncHandler', () => {
    function createResponse() {
      return {
        statusCode: 200,
        body: null,
        status() { return this; },
        json() { return this; }
      };
    }

    it('应该把 async reject 通过 next(error) 交接', async () => {
      const failure = new Error('下游失败');
      const handler = asyncHandler(async () => {
        throw failure;
      });
      const res = createResponse();
      const forwarded = [];
      await handler({ headers: {} }, res, error => forwarded.push(error));

      assert.deepStrictEqual(forwarded, [failure]);
      assert.strictEqual(res.body, null);
    });

    it('应该把包装函数内的同步异常通过 next(error) 交接', async () => {
      const failure = new Error('同步失败');
      const handler = asyncHandler(() => {
        throw failure;
      });
      const res = createResponse();
      const forwarded = [];
      await handler({ headers: {} }, res, error => forwarded.push(error));

      assert.deepStrictEqual(forwarded, [failure]);
      assert.strictEqual(res.body, null);
    });

    it('应该让正常完成的处理器直接响应', async () => {
      const handler = asyncHandler(async (req, res) => {
        res.json({ ok: true });
      });
      const res = { json(body) { this.body = body; return this; } };
      const forwarded = [];
      await handler({ headers: {} }, res, error => forwarded.push(error));

      assert.deepStrictEqual(forwarded, []);
      assert.deepStrictEqual(res.body, { ok: true });
    });
  });

  describe('apiErrorHandler', () => {
    const originalConsoleError = console.error;
    const consoleLines = [];

    afterEach(() => {
      console.error = originalConsoleError;
      consoleLines.length = 0;
    });

    function createResponse() {
      return {
        statusCode: 200,
        body: null,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        }
      };
    }

    function captureConsole() {
      console.error = (...parts) => consoleLines.push(parts.join(' '));
    }

    it('应该在响应已发送后把错误交回错误链', () => {
      const failure = new Error('响应后异常');
      const res = createResponse();
      res.headersSent = true;
      const forwarded = [];

      apiErrorHandler(failure, { headers: {} }, res, error => forwarded.push(error));

      assert.deepStrictEqual(forwarded, [failure]);
      assert.strictEqual(res.body, null);
      assert.deepStrictEqual(consoleLines, []);
    });

    it('应该完整保留公开业务错误的 code、message、details、retryable 与状态', () => {
      captureConsole();
      const error = agentError('MAA_EXECUTION_BUSY', 'MAA 正在被其他任务使用', {
        statusCode: 409,
        retryable: true,
        details: { owner: 'run-1' }
      });
      const res = createResponse();

      apiErrorHandler(error, { method: 'POST', path: '/api/agent/actions/start' }, res, () => {});

      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.message, 'MAA 正在被其他任务使用');
      assert.deepStrictEqual(res.body.error, {
        code: 'MAA_EXECUTION_BUSY',
        details: { owner: 'run-1' },
        retryable: true
      });
      assert.strictEqual(consoleLines[0], '[API] POST /api/agent/actions/start -> 409 MAA_EXECUTION_BUSY MAA 正在被其他任务使用');
    });

    it('应该保留只带状态的存量业务错误（训练计划冲突）', () => {
      captureConsole();
      const error = Object.assign(new Error('养成队列已变化，请重新生成计划后应用'), { statusCode: 409 });
      const res = createResponse();

      apiErrorHandler(error, { method: 'POST', path: '/api/agent/actions/apply-training-plan' }, res, () => {});

      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.message, '养成队列已变化，请重新生成计划后应用');
    });

    it('应该对未知内部错误返回统一 500 且不泄露 message/details/堆栈', () => {
      captureConsole();
      const error = new Error('内部堆栈泄露标记 /etc/la-pluma/token');
      const res = createResponse();

      apiErrorHandler(error, { method: 'GET', path: '/api/agent/status' }, res, () => {});

      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.message, '服务器内部错误');
      assert.deepStrictEqual(res.body.error, {
        code: 'AGENT_INTERNAL_ERROR',
        details: {},
        retryable: false
      });
      assert.ok(!JSON.stringify(res.body).includes('内部堆栈泄露标记'));
      assert.ok(!consoleLines.join('\n').includes('内部堆栈泄露标记'));
    });

    it('不应该按 5xx 推导 retryable，未知错误保持 false', () => {
      captureConsole();
      const retryableFailure = agentError('AGENT_RUN_FAILED', '执行失败', {
        statusCode: 500,
        retryable: true
      });
      const retryableRes = createResponse();
      apiErrorHandler(retryableFailure, { method: 'GET', path: '/api/agent/status' }, retryableRes, () => {});
      assert.strictEqual(retryableRes.statusCode, 500);
      assert.strictEqual(retryableRes.body.error.retryable, true);

      const unknownRes = createResponse();
      apiErrorHandler(new Error('意外'), { method: 'GET', path: '/api/agent/status' }, unknownRes, () => {});
      assert.strictEqual(unknownRes.statusCode, 500);
      assert.strictEqual(unknownRes.body.error.retryable, false);
    });

    it('应该把范围外的错误状态归一到 500', () => {
      captureConsole();
      for (const statusCode of [200, 302, 399, 600, 999]) {
        const res = createResponse();
        apiErrorHandler(
          Object.assign(new Error('异常状态'), { statusCode }),
          { method: 'GET', path: '/api/agent/status' },
          res,
          () => {}
        );
        assert.strictEqual(res.statusCode, 500, `statusCode=${statusCode}`);
        assert.strictEqual(res.body.message, '服务器内部错误');
      }
    });

    it('应该把请求框架错误映射为稳定 JSON 错误', () => {
      captureConsole();
      const cases = [
        {
          error: Object.assign(new SyntaxError('Unexpected token'), {
            status: 400,
            statusCode: 400,
            type: 'entity.parse.failed'
          }),
          status: 400,
          code: 'AGENT_REQUEST_BODY_INVALID',
          message: '请求体不是有效的 JSON'
        },
        {
          error: Object.assign(new Error('request entity too large'), {
            status: 413,
            statusCode: 413,
            type: 'entity.too.large'
          }),
          status: 413,
          code: 'AGENT_REQUEST_BODY_TOO_LARGE',
          message: '请求体超过允许的大小'
        },
        {
          error: Object.assign(new Error('unsupported charset'), {
            status: 415,
            statusCode: 415,
            type: 'charset.unsupported'
          }),
          status: 415,
          code: 'AGENT_REQUEST_CHARSET_UNSUPPORTED',
          message: '请求字符集不支持'
        }
      ];

      for (const { error, status, code, message } of cases) {
        const res = createResponse();
        apiErrorHandler(error, { method: 'POST', path: '/api/agent/status' }, res, () => {});
        assert.strictEqual(res.statusCode, status, code);
        assert.strictEqual(res.body.error.code, code);
        assert.strictEqual(res.body.message, message);
        assert.deepStrictEqual(res.body.error.details, {});
      }
    });

    it('应该把路径参数解码失败映射为稳定 400 且不回显原始参数', () => {
      captureConsole();
      const error = new URIError("Failed to decode param '%E0%A4%A'");
      error.status = 400;
      error.statusCode = 400;
      const res = createResponse();

      apiErrorHandler(error, { method: 'GET', path: '/api/agent/runs/%E0%A4%A' }, res, () => {});

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error.code, 'AGENT_REQUEST_PATH_INVALID');
      assert.strictEqual(res.body.message, '请求路径参数无法解码');
      assert.ok(!JSON.stringify(res.body).includes('%E0%A4%A'));
    });

    it('日志不应回显请求查询串', () => {
      captureConsole();
      const res = createResponse();

      apiErrorHandler(
        agentError('AGENT_RUN_NOT_FOUND', '未找到 run', { statusCode: 404 }),
        {
          method: 'GET',
          path: '/api/agent/runs/run-1',
          url: '/api/agent/runs/run-1?token=secret-query-value',
          originalUrl: '/api/agent/runs/run-1?token=secret-query-value',
          query: { token: 'secret-query-value' }
        },
        res,
        () => {}
      );

      assert.strictEqual(res.statusCode, 404);
      const logged = consoleLines.join('\n');
      assert.ok(logged.includes('[API] GET /api/agent/runs/run-1 -> 404'));
      assert.ok(!logged.includes('secret-query-value'));
    });
  });

  describe('HTTP 错误链集成', () => {
    const servers = [];

    async function listen(app) {
      const server = createServer(app);
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      return server.address().port;
    }

    afterEach(async () => {
      while (servers.length) {
        const server = servers.pop();
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
      }
    });

    it('已发送响应后的异常应保持响应完整并交回错误链', async () => {
      const app = express();
      const forwarded = [];
      app.get('/api/late', asyncHandler(async (_req, res) => {
        res.status(200).json({ ok: true });
        throw new Error('响应后异常');
      }));
      app.use('/api', apiErrorHandler);
      app.use((error, _req, _res, _next) => {
        // 响应已完成，这里只记录错误链收到的异常，不再向下转发
        forwarded.push(error);
      });

      const port = await listen(app);
      const response = await fetch(`http://127.0.0.1:${port}/api/late`);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), { ok: true });
      assert.strictEqual(forwarded.length, 1);
      assert.strictEqual(forwarded[0].message, '响应后异常');
    });
  });
});

console.log('✅ 所有测试通过！');
