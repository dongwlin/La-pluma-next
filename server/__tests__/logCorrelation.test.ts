import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExecutionRequest, ExecutionResponseWriter } from '../controllers/executionDto.ts'
import type { TrackedExecutionLifecycle } from '../controllers/agentExecutionController.ts'

// 假 MAA CLI 必须在导入服务模块之前就位（CLI 路径在模块导入时读取）。
const root = await mkdtemp(join(tmpdir(), 'la-pluma-log-correlation-'))
const cliPath = join(root, 'maa')
let failWrites = false
const previousEnv: Record<string, string | undefined> = Object.fromEntries(
  ['MAA_CLI_PATH', 'LA_PLUMA_MAA_LOCK_FILE'].map(key => [key, process.env[key]])
)
process.env.MAA_CLI_PATH = cliPath
process.env.LA_PLUMA_MAA_LOCK_FILE = join(root, 'maa.lock')

await writeFile(cliPath, `#!${process.execPath}
import { writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2);
writeSync(1, 'Authorization: Bearer cli-header-secret\\n');
writeSync(1, 'GET /connect_client?token=cli-query-secret&deviceId=1-2\\n');
writeSync(2, 'token=cli-stderr-secret\\n');
if (args.includes('--slow')) await delay(120);
process.exitCode = 0;
`, { mode: 0o755 })

const { createLaPlumaApp } = await import('../app.ts')
const { executeTrackedAgentAction } = await import('../controllers/agentExecutionController.ts')
const operatorTraining = (await import('../services/operatorTrainingService.ts')).default
const {
  clearRealtimeLogs,
  getRealtimeLogs,
  getTaskStatus
} = await import('../services/maaProcessService.ts')
const { execMaaCommand } = await import('../services/maaExecutionService.ts')
const { getMaaExecutionLeaseSnapshot } = await import('../services/executionCoordinatorService.ts')
const { executeScheduledTaskFromCron } = await import('../services/schedulerService.ts')
const {
  initializeAgentRunStore,
  listAgentRuns,
  resetAgentRunsForTests
} = await import('../services/agentRunService.ts')
const { writeJsonFile } = await import('../utils/fileHelper.ts')
const { loggerManager } = await import('../utils/logger.ts')
const { getLogContext } = await import('../utils/logContext.ts')

for (const name of ['AgentRoutes', 'AgentRunService', 'MaaService', 'Scheduler', 'Notification']) {
  loggerManager.getLogger(name).enableConsole = false
}
const routesLogger = loggerManager.getLogger('AgentRoutes')
const schedulerLogger = loggerManager.getLogger('Scheduler')

await initializeAgentRunStore({
  filePath: join(root, 'agent-runs.json'),
  writeStore: async (filePath, snapshot) => {
    if (failWrites) throw new Error('模拟 Run 存储写入失败')
    await writeJsonFile(filePath, snapshot)
  }
})

const servers: Server[] = []
const consoleLines: string[] = []
const originalConsoleError = console.error

async function listen(app: RequestListener): Promise<number> {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('监听端口获取失败')
  }
  return address.port
}

function captureConsole(): void {
  console.error = (...parts: unknown[]): void => {
    consoleLines.push(parts.map(String).join(' '))
  }
}

function malformedBodyRequest(port: number, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/agent/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{"broken":'
  })
}

/** 执行适配器只读取 headers/query/body/get；其余字段由路由声明补齐。 */
function createRequest(): ExecutionRequest {
  return { headers: {}, query: {}, body: {}, get: () => undefined }
}

/** 执行响应夹具：记录状态码与 JSON 载荷，供断言运行生命周期。 */
interface TestResponse extends ExecutionResponseWriter {
  statusCode: number
  body: unknown
  headers: Record<string, string>
}

function createResponse(): TestResponse {
  const res: TestResponse = {
    statusCode: 200,
    headersSent: false,
    body: null,
    headers: {},
    set(name: string, value: string) {
      this.headers[name] = value
      return this
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: object) {
      this.body = body
      return this
    }
  }
  return res
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} 应为 JSON 对象`)
  return value
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  assert.ok(isRecord(body), '响应应为 JSON 对象')
  return body
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('等待执行结束超时')
}

async function waitForLeaseFree(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await getMaaExecutionLeaseSnapshot()).state === 'free') return
    await delay(10)
  }
  throw new Error('等待执行租约释放超时')
}

afterEach(async () => {
  console.error = originalConsoleError
  consoleLines.length = 0
  while (servers.length) {
    const server = servers.pop()
    assert.ok(server)
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

describe('request id correlation', () => {
  it('使用有限长度请求 id，并在响应头、meta 与 API 日志中保持一致', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    captureConsole()

    const cases: Array<{ headers: Record<string, string>; supplied: string | null }> = [
      { headers: { 'x-request-id': 'client-correlation-1' }, supplied: 'client-correlation-1' },
      { headers: {}, supplied: null },
      { headers: { 'x-request-id': 'x'.repeat(200) }, supplied: 'x'.repeat(200) },
      { headers: { 'x-request-id': 'bad value' }, supplied: 'bad value' }
    ]

    for (const { headers, supplied } of cases) {
      consoleLines.length = 0
      const response = await malformedBodyRequest(port, headers)
      assert.equal(response.status, 400)

      const requestId = response.headers.get('x-request-id')
      assert.ok(requestId, '响应应带请求 id')
      assert.ok(String(requestId).length <= 64)
      if (supplied && supplied.length <= 64 && !supplied.includes(' ')) {
        assert.equal(requestId, supplied)
      } else {
        assert.match(String(requestId), /^[0-9a-f-]{36}$/)
      }
      assert.equal(readRecord((await readJson(response)).meta, 'meta').requestId, requestId)

      const logged = consoleLines.join('\n')
      assert.ok(logged.includes('[Api][WARN]'))
      assert.ok(logged.includes(`req=${requestId}`))
      assert.ok(logged.includes('[API] POST /api/agent/status -> 400 AGENT_REQUEST_BODY_INVALID'))
      if (supplied && supplied !== requestId) assert.ok(!logged.includes(supplied))
    }
  })

  it('已知 4xx 记 WARN、未知 5xx 记 ERROR，且日志不泄露凭据与请求内容', async () => {
    const app = createLaPlumaApp({ env: {} })
    const port = await listen(app)
    const originalApply = operatorTraining.applyPlanToTasks
    captureConsole()

    try {
      const clientError = await malformedBodyRequest(port, { 'x-request-id': 'grade-4xx' })
      assert.equal(clientError.status, 400)
      assert.ok(consoleLines.join('\n').includes('[Api][WARN]'))
      assert.ok(consoleLines.join('\n').includes('req=grade-4xx'))

      operatorTraining.applyPlanToTasks = async () => {
        throw new Error('内部堆栈泄露标记 /etc/la-pluma/token')
      }
      consoleLines.length = 0
      const serverError = await fetch(
        `http://127.0.0.1:${port}/api/agent/actions/apply-training-plan?token=query-secret-value`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer header-secret-value',
            'x-request-id': 'grade-5xx'
          },
          body: JSON.stringify({
            plan: { queueRevision: 'stale' },
            token: 'body-secret-value',
            password: 'body-password-value'
          })
        }
      )

      assert.equal(serverError.status, 500)
      const body = await readJson(serverError)
      assert.equal(readRecord(body.error, 'error').code, 'AGENT_INTERNAL_ERROR')
      const logged = consoleLines.join('\n')
      assert.ok(logged.includes('[Api][ERROR]'))
      assert.ok(logged.includes('[API] POST /api/agent/actions/apply-training-plan -> 500 AGENT_INTERNAL_ERROR'))
      assert.ok(logged.includes('req=grade-5xx'))
      for (const secret of [
        '内部堆栈泄露标记',
        'query-secret-value',
        'header-secret-value',
        'body-secret-value',
        'body-password-value'
      ]) {
        assert.ok(!logged.includes(secret), `日志不得包含 ${secret}`)
        assert.ok(!JSON.stringify(body).includes(secret), `响应不得包含 ${secret}`)
      }

      operatorTraining.applyPlanToTasks = async () => {
        throw Object.assign(
          new Error('队列冲突 Authorization: Bearer message-secret&token=message-query-secret'),
          { statusCode: 409 }
        )
      }
      consoleLines.length = 0
      const businessError = await fetch(`http://127.0.0.1:${port}/api/agent/actions/apply-training-plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': 'redact-409' },
        body: JSON.stringify({ plan: { queueRevision: 'stale' } })
      })
      assert.equal(businessError.status, 409)
      const businessLog = consoleLines.join('\n')
      assert.ok(businessLog.includes('[Api][WARN]'))
      assert.ok(!businessLog.includes('message-secret'))
      assert.ok(!businessLog.includes('message-query-secret'))
      assert.ok(businessLog.includes('[REDACTED]'))
    } finally {
      operatorTraining.applyPlanToTasks = originalApply
    }
  })

  it('执行日志记录 runId/operationId 并脱敏子进程输出', async () => {
    const { withExecutionLogContext, withRequestLogContext } = await import('../utils/logContext.ts')
    clearRealtimeLogs()
    loggerManager.getLogger('MaaService').clear()

    await withRequestLogContext({ requestId: 'req-exec-1' }, () =>
      withExecutionLogContext({ runId: 'run-exec-1', operationId: 'fight' }, () =>
        execMaaCommand('fight', ['1-7'], '关联测试', 'combat', true)
      )
    )

    const entries = getRealtimeLogs(500)
    assert.ok(entries.length > 0)
    for (const entry of entries) {
      assert.equal(entry.runId, 'run-exec-1')
      assert.equal(entry.operationId, 'fight')
    }

    const loggedText = entries.map(entry => entry.message).join('\n')
    assert.ok(!loggedText.includes('cli-header-secret'))
    assert.ok(!loggedText.includes('cli-query-secret'))
    assert.ok(!loggedText.includes('cli-stderr-secret'))
    assert.ok(loggedText.includes('[REDACTED]'))
    assert.ok(loggedText.includes('deviceId=1-2'))

    const serviceEntries = loggerManager.getLogger('MaaService').getAllLogs()
      .filter(entry => entry.runId === 'run-exec-1')
    assert.ok(serviceEntries.length > 0, '结构化日志应记录执行关联字段')
    assert.ok(serviceEntries.every(entry => entry.operationId === 'fight'))
    assert.ok(serviceEntries.some(entry => entry.requestId === 'req-exec-1'))
    assert.ok(!JSON.stringify(serviceEntries).includes('cli-header-secret'))
  })

  it('响应返回后后台执行仍保留 run 关联，且上下文不泄漏到无 Run 调用', async () => {
    const { withExecutionLogContext, withRequestLogContext } = await import('../utils/logContext.ts')
    clearRealtimeLogs()
    loggerManager.getLogger('MaaService').clear()

    await withExecutionLogContext({ runId: 'run-bg-1', operationId: 'run_task' }, async () => {
      await withRequestLogContext({ requestId: 'req-bg-1' }, async () => {
        const started = await execMaaCommand('fight', ['1-7', '--slow'], '后台关联', 'combat', false)
        assert.equal(started.message, '任务已在后台启动')
      })
    })

    // 发起请求的作用域已经结束，后台子进程仍在运行
    assert.equal(getTaskStatus().isRunning, true)
    await waitFor(() => getTaskStatus().isRunning === false)
    await waitForLeaseFree()

    const completion = getRealtimeLogs(500).find(entry => entry.message.includes('命令执行完成'))
    assert.ok(completion, '后台进程结束时仍应记录完成日志')
    assert.equal(completion.runId, 'run-bg-1')
    assert.equal(completion.operationId, 'run_task')

    const backgroundEntry = loggerManager.getLogger('MaaService').getAllLogs()
      .filter(entry => entry.message.includes('命令执行完成'))
      .at(-1)
    assert.ok(backgroundEntry, '结构化日志应记录后台完成')
    assert.equal(backgroundEntry.runId, 'run-bg-1')
    assert.equal(backgroundEntry.operationId, 'run_task')

    clearRealtimeLogs()
    await execMaaCommand('fight', ['1-7'], '无关联测试', 'combat', true)
    assert.deepEqual(getLogContext(), {})
    const directEntries = getRealtimeLogs(500)
    assert.ok(directEntries.length > 0)
    assert.ok(directEntries.every(entry => entry.runId === undefined))
    assert.ok(directEntries.every(entry => entry.operationId === undefined))
  })
})

describe('run ownership correlation', () => {
  it('后台收尾失败与 cron 流程都由 Run 所有者记录 runId/operationId', async () => {
    failWrites = false
    const req = createRequest()
    const res = createResponse()
    // 执行回调在适配器内部运行，用数组收集实际注入的生命周期与上下文。
    const lifecycles: TrackedExecutionLifecycle[] = []
    const contexts: Array<{ runId?: string; operationId?: string }> = []

    await executeTrackedAgentAction(req, res, {
      operationId: 'run_task',
      input: { command: 'fight', waitForCompletion: false },
      waitForCompletion: false,
      execute: async (lifecycle, { runId }) => {
        lifecycles.push(lifecycle)
        contexts.push({ ...getLogContext(), runId })
        return { accepted: true }
      }
    })

    const responseData = readRecord(readRecord(res.body, 'response body').data, 'response data')
    const runId = responseData.runId
    assert.equal(typeof runId, 'string')
    assert.equal(res.statusCode, 202)
    const [executeContext] = contexts
    assert.equal(executeContext?.runId, runId)
    assert.equal(executeContext?.operationId, 'run_task')

    // 响应已返回且发起作用域已结束：此时统一收尾由 Run 所有者记录。
    assert.deepEqual(getLogContext(), {})
    failWrites = true
    routesLogger.clear()
    const [settledLifecycle] = lifecycles
    await settledLifecycle?.onSettled?.({ ok: true, result: { done: true } })

    const failureEntry = routesLogger.getAllLogs()
      .find(entry => entry.message.includes('更新或持久化 Agent run 终态失败'))
    assert.ok(failureEntry, '后台收尾失败应由 Run 所有者记录')
    assert.equal(failureEntry.runId, runId)
    assert.equal(failureEntry.operationId, 'run_task')
    assert.ok(JSON.stringify(failureEntry).includes('模拟 Run 存储写入失败'))
    assert.ok(!JSON.stringify(res.body).includes('模拟 Run 存储写入失败'))

    failWrites = false
    resetAgentRunsForTests()
    schedulerLogger.clear()
    const cronResult = await executeScheduledTaskFromCron([], 'cron-log-correlation')
    assert.equal(cronResult.success, true)
    const [cronRun] = listAgentRuns({ operationId: 'run_daily_flow' })
    assert.ok(cronRun, '定时流程应创建 Run')
    const startEntry = schedulerLogger.getAllLogs()
      .find(entry => entry.message.includes('开始执行任务流程'))
    assert.ok(startEntry, '流程开始日志应由调度器记录')
    assert.equal(startEntry.runId, cronRun.runId)
    assert.equal(startEntry.operationId, 'run_daily_flow')

    resetAgentRunsForTests()
  })

  it('服务端不注册吞掉致命异常的处理器', () => {
    const before = {
      uncaughtException: process.listenerCount('uncaughtException'),
      unhandledRejection: process.listenerCount('unhandledRejection')
    }

    createLaPlumaApp({ env: {} })

    assert.equal(process.listenerCount('uncaughtException'), before.uncaughtException)
    assert.equal(process.listenerCount('unhandledRejection'), before.unhandledRejection)
  })
})
