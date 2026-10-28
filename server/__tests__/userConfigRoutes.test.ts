import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createLaPlumaApp } from '../app.ts'
import { createUserConfigStorage } from '../services/configStorageService.ts'
import type { UserConfigStorage, UserConfigStore } from '../services/configStorageService.ts'

const servers: Server[] = []
const tempDirs: string[] = []

/** 断言用的 JSON 对象视图：非空、非数组对象本身就是该结构，谓词可靠收窄。 */
type JsonRecord = Record<string, unknown>

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRecord(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) {
    assert.fail(`${label} 必须是 JSON 对象`)
  }
  return value
}

async function readJson(response: Response): Promise<JsonRecord> {
  return readRecord(await response.json(), '响应载荷')
}

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

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function startAppWithStorage(
  { env = {} }: { env?: Record<string, string> } = {}
): Promise<{ port: number; storage: UserConfigStore; configDir: string }> {
  const configDir = await makeTempDir('la-pluma-user-config-http-')
  const storage = createUserConfigStorage({ configDir })
  const app = createLaPlumaApp({ env, userConfigStorage: storage })
  const port = await listen(app)
  return { port, storage, configDir }
}

function configUrl(port: number, path = ''): string {
  return `http://127.0.0.1:${port}/api/agent/config/user${path}`
}

afterEach(async () => {
  let server = servers.pop()
  while (server) {
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = servers.pop()
  }
  let dir = tempDirs.pop()
  while (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = tempDirs.pop()
  }
})

describe('user config routes mounted with injected storage', () => {
  it('keeps the legacy URLs, success fields and storage-backed lifecycle', async () => {
    const { port } = await startAppWithStorage()
    const payload = {
      enabled: true,
      legacyField: 'keep-me',
      extension: { nested: { allowed: true } }
    }

    const emptyList = await fetch(configUrl(port))
    assert.equal(emptyList.status, 200)
    const emptyListPayload = await readJson(emptyList)
    assert.equal(emptyListPayload.success, true)
    assert.equal(emptyListPayload.message, '操作成功')
    assert.deepEqual(emptyListPayload.data, {})

    const save = await fetch(configUrl(port, '/auto-update'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    assert.equal(save.status, 200)
    const savePayload = await readJson(save)
    assert.equal(savePayload.success, true)
    assert.equal(savePayload.message, '配置保存成功')
    assert.equal(savePayload.data, null)

    const read = await fetch(configUrl(port, '/auto-update'))
    assert.equal(read.status, 200)
    const readPayload = await readJson(read)
    assert.equal(readPayload.success, true)
    assert.equal(readPayload.message, '操作成功')
    assert.deepEqual(readPayload.data, payload)

    const list = await fetch(configUrl(port))
    const listPayload = await readJson(list)
    assert.deepEqual(readRecord(listPayload.data, 'data')['auto-update'], payload)

    const remove = await fetch(configUrl(port, '/auto-update'), { method: 'DELETE' })
    assert.equal(remove.status, 200)
    const removePayload = await readJson(remove)
    assert.equal(removePayload.success, true)
    assert.equal(removePayload.message, '配置删除成功')
    assert.equal(removePayload.data, null)

    const missingRead = await fetch(configUrl(port, '/auto-update'))
    const missingReadPayload = await readJson(missingRead)
    assert.equal(missingReadPayload.success, true)
    assert.equal(missingReadPayload.data, null)

    const missingRemove = await fetch(configUrl(port, '/auto-update'), { method: 'DELETE' })
    const missingRemovePayload = await readJson(missingRemove)
    assert.equal(missingRemovePayload.success, true)
    assert.equal(missingRemovePayload.message, '配置不存在')
  })

  it('maps validation and storage failures through the config error chain', async () => {
    const { port } = await startAppWithStorage()

    const invalidType = await fetch(configUrl(port, '/not-a-type'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    assert.equal(invalidType.status, 400)
    const invalidTypePayload = await readJson(invalidType)
    assert.equal(invalidTypePayload.success, false)
    const invalidTypeError = readRecord(invalidTypePayload.error, 'error')
    assert.equal(invalidTypeError.code, 'AGENT_CONFIG_TYPE_INVALID')
    assert.equal(invalidTypeError.retryable, false)

    const invalidBody = await fetch(configUrl(port, '/auto-update'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3]'
    })
    assert.equal(invalidBody.status, 400)
    const invalidBodyPayload = await readJson(invalidBody)
    const invalidBodyError = readRecord(invalidBodyPayload.error, 'error')
    assert.equal(invalidBodyError.code, 'AGENT_CONFIG_DATA_INVALID')
    assert.equal(invalidBodyError.retryable, false)

    // 解析失败的请求体由统一错误出口应答，不进入存储层
    const brokenJson = await fetch(configUrl(port, '/auto-update'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken'
    })
    assert.equal(brokenJson.status, 400)
    const brokenJsonPayload = await readJson(brokenJson)
    assert.equal(readRecord(brokenJsonPayload.error, 'error').code, 'AGENT_REQUEST_BODY_INVALID')

    // 非校验类存储失败按路由 fallback code 以 500 返回
    // 只驱动读取路径；其余存储操作在断言失败前不会被调用。
    const failingStorage: UserConfigStorage = {
      loadUserConfig: async () => ({
        success: false,
        message: '读取配置失败',
        error: { code: 'AGENT_INTERNAL_ERROR', details: {}, retryable: false },
        meta: { requestId: null, dryRun: false }
      }),
      saveUserConfig: async () => assert.fail('保存不应被调用'),
      getAllUserConfigs: async () => assert.fail('列表不应被调用'),
      deleteUserConfig: async () => assert.fail('删除不应被调用')
    }
    const failingAppOptions = { env: {}, userConfigStorage: failingStorage }
    const app = createLaPlumaApp(failingAppOptions)
    const failingPort = await listen(app)
    const failedRead = await fetch(configUrl(failingPort, '/auto-update'))
    assert.equal(failedRead.status, 500)
    const failedReadPayload = await readJson(failedRead)
    const failedError = readRecord(failedReadPayload.error, 'error')
    assert.equal(failedError.code, 'AGENT_CONFIG_LOAD_FAILED')
    assert.equal(failedError.retryable, true)
  })

  it('keeps optional token auth ahead of the injected config routes', async () => {
    const { port } = await startAppWithStorage({ env: { LA_PLUMA_TOKEN: 'config-secret' } })

    const unauthorized = await fetch(configUrl(port))
    assert.equal(unauthorized.status, 401)
    const unauthorizedPayload = await readJson(unauthorized)
    assert.equal(readRecord(unauthorizedPayload.error, 'error').code, 'AGENT_AUTH_REQUIRED')
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer realm="la-pluma"')

    const headerToken = await fetch(configUrl(port), {
      headers: { 'x-la-pluma-token': 'config-secret' }
    })
    assert.equal(headerToken.status, 200)
    const headerTokenPayload = await readJson(headerToken)
    assert.equal(headerTokenPayload.success, true)

    const save = await fetch(configUrl(port, '/notification'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer config-secret' },
      body: JSON.stringify({ channel: 'telegram' })
    })
    assert.equal(save.status, 200)
    const savePayload = await readJson(save)
    assert.equal(savePayload.success, true)
  })

  it('isolates two injected storage instances across separate apps', async () => {
    const first = await startAppWithStorage()
    const second = await startAppWithStorage()

    const firstSave = await fetch(configUrl(first.port, '/notification'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'first-instance' })
    })
    assert.equal(firstSave.status, 200)

    const secondSave = await fetch(configUrl(second.port, '/notification'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'second-instance' })
    })
    assert.equal(secondSave.status, 200)

    const firstRead = await fetch(configUrl(first.port))
    const firstReadPayload = await readJson(firstRead)
    assert.deepEqual(firstReadPayload.data, {
      notification: { channel: 'first-instance' }
    })

    const secondRead = await fetch(configUrl(second.port))
    const secondReadPayload = await readJson(secondRead)
    assert.deepEqual(secondReadPayload.data, {
      notification: { channel: 'second-instance' }
    })

    const remove = await fetch(configUrl(first.port, '/notification'), { method: 'DELETE' })
    assert.equal(remove.status, 200)

    const afterRemove = await fetch(configUrl(first.port, '/notification'))
    const afterRemovePayload = await readJson(afterRemove)
    assert.equal(afterRemovePayload.data, null)

    const secondAfterFirstRemove = await fetch(configUrl(second.port, '/notification'))
    const secondAfterFirstRemovePayload = await readJson(secondAfterFirstRemove)
    assert.deepEqual(secondAfterFirstRemovePayload.data, {
      channel: 'second-instance'
    })
  })
})
