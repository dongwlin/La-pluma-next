import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createLaPlumaApp } from '../server.js'
import { createUserConfigStorage } from '../services/configStorageService.js'

const servers = []
const tempDirs = []

async function listen(app) {
  const server = createServer(app)
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function startAppWithStorage({ env = {} } = {}) {
  const configDir = await makeTempDir('la-pluma-user-config-http-')
  const storage = createUserConfigStorage({ configDir })
  const app = createLaPlumaApp({ env, userConfigStorage: storage })
  const port = await listen(app)
  return { port, storage, configDir }
}

function configUrl(port, path = '') {
  return `http://127.0.0.1:${port}/api/agent/config/user${path}`
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true })
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
    const emptyListPayload = await emptyList.json()
    assert.equal(emptyListPayload.success, true)
    assert.equal(emptyListPayload.message, '操作成功')
    assert.deepEqual(emptyListPayload.data, {})

    const save = await fetch(configUrl(port, '/auto-update'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    assert.equal(save.status, 200)
    const savePayload = await save.json()
    assert.equal(savePayload.success, true)
    assert.equal(savePayload.message, '配置保存成功')
    assert.equal(savePayload.data, null)

    const read = await fetch(configUrl(port, '/auto-update'))
    assert.equal(read.status, 200)
    const readPayload = await read.json()
    assert.equal(readPayload.success, true)
    assert.equal(readPayload.message, '操作成功')
    assert.deepEqual(readPayload.data, payload)

    const list = await fetch(configUrl(port))
    const listPayload = await list.json()
    assert.deepEqual(listPayload.data['auto-update'], payload)

    const remove = await fetch(configUrl(port, '/auto-update'), { method: 'DELETE' })
    assert.equal(remove.status, 200)
    const removePayload = await remove.json()
    assert.equal(removePayload.success, true)
    assert.equal(removePayload.message, '配置删除成功')
    assert.equal(removePayload.data, null)

    const missingRead = await fetch(configUrl(port, '/auto-update'))
    const missingReadPayload = await missingRead.json()
    assert.equal(missingReadPayload.success, true)
    assert.equal(missingReadPayload.data, null)

    const missingRemove = await fetch(configUrl(port, '/auto-update'), { method: 'DELETE' })
    const missingRemovePayload = await missingRemove.json()
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
    const invalidTypePayload = await invalidType.json()
    assert.equal(invalidTypePayload.success, false)
    assert.equal(invalidTypePayload.error.code, 'AGENT_CONFIG_TYPE_INVALID')
    assert.equal(invalidTypePayload.error.retryable, false)

    const invalidBody = await fetch(configUrl(port, '/auto-update'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2,3]'
    })
    assert.equal(invalidBody.status, 400)
    const invalidBodyPayload = await invalidBody.json()
    assert.equal(invalidBodyPayload.error.code, 'AGENT_CONFIG_DATA_INVALID')
    assert.equal(invalidBodyPayload.error.retryable, false)

    // 解析失败的请求体由统一错误出口应答，不进入存储层
    const brokenJson = await fetch(configUrl(port, '/auto-update'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken'
    })
    assert.equal(brokenJson.status, 400)
    const brokenJsonPayload = await brokenJson.json()
    assert.equal(brokenJsonPayload.error.code, 'AGENT_REQUEST_BODY_INVALID')

    // 非校验类存储失败按路由 fallback code 以 500 返回
    const failingStorage = {
      loadUserConfig: async () => ({
        success: false,
        message: '读取配置失败',
        error: { code: 'AGENT_INTERNAL_ERROR', details: {} }
      })
    }
    const app = createLaPlumaApp({ env: {}, userConfigStorage: failingStorage })
    const failingPort = await listen(app)
    const failedRead = await fetch(configUrl(failingPort, '/auto-update'))
    assert.equal(failedRead.status, 500)
    const failedReadPayload = await failedRead.json()
    assert.equal(failedReadPayload.error.code, 'AGENT_CONFIG_LOAD_FAILED')
    assert.equal(failedReadPayload.error.retryable, true)
  })

  it('keeps optional token auth ahead of the injected config routes', async () => {
    const { port } = await startAppWithStorage({ env: { LA_PLUMA_TOKEN: 'config-secret' } })

    const unauthorized = await fetch(configUrl(port))
    assert.equal(unauthorized.status, 401)
    const unauthorizedPayload = await unauthorized.json()
    assert.equal(unauthorizedPayload.error.code, 'AGENT_AUTH_REQUIRED')
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer realm="la-pluma"')

    const headerToken = await fetch(configUrl(port), {
      headers: { 'x-la-pluma-token': 'config-secret' }
    })
    assert.equal(headerToken.status, 200)
    assert.equal((await headerToken.json()).success, true)

    const save = await fetch(configUrl(port, '/notification'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer config-secret' },
      body: JSON.stringify({ channel: 'telegram' })
    })
    assert.equal(save.status, 200)
    assert.equal((await save.json()).success, true)
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
    const firstReadPayload = await firstRead.json()
    assert.deepEqual(firstReadPayload.data, {
      notification: { channel: 'first-instance' }
    })

    const secondRead = await fetch(configUrl(second.port))
    const secondReadPayload = await secondRead.json()
    assert.deepEqual(secondReadPayload.data, {
      notification: { channel: 'second-instance' }
    })

    const remove = await fetch(configUrl(first.port, '/notification'), { method: 'DELETE' })
    assert.equal(remove.status, 200)

    const afterRemove = await fetch(configUrl(first.port, '/notification'))
    assert.equal((await afterRemove.json()).data, null)

    const secondAfterFirstRemove = await fetch(configUrl(second.port, '/notification'))
    assert.deepEqual((await secondAfterFirstRemove.json()).data, {
      channel: 'second-instance'
    })
  })
})
