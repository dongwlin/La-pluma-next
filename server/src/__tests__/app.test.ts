import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createLaPlumaApp } from '../app.ts'

const servers: Server[] = []
const tempDirs: string[] = []

async function productionApp(basePath = '/'): Promise<string> {
  const clientDistPath = await mkdtemp(join(tmpdir(), 'la-pluma-app-'))
  tempDirs.push(clientDistPath)
  await mkdir(join(clientDistPath, 'api', 'agent'), { recursive: true })
  await mkdir(join(clientDistPath, 'health'), { recursive: true })
  await writeFile(join(clientDistPath, 'index.html'), '<title>Application shell fixture</title>')
  await writeFile(join(clientDistPath, 'api', 'agent', 'manifest'), 'static manifest shadow')
  await writeFile(join(clientDistPath, 'api', 'missing'), 'static API shadow')
  await writeFile(join(clientDistPath, 'health', 'internal'), 'static probe shadow')
  const app = createLaPlumaApp({
    env: { NODE_ENV: 'production', LA_PLUMA_BASE_PATH: basePath },
    clientDistPath
  })
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closing = new Promise<void>(resolve => server.close(() => resolve()))
    server.closeAllConnections()
    await closing
  }
  for (const path of tempDirs.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('Application route ownership', () => {
  it('keeps API routes and JSON misses ahead of production files', async () => {
    const origin = await productionApp()
    const manifest = await fetch(`${origin}/api/agent/manifest`)
    assert.equal(manifest.status, 200)
    assert.match(manifest.headers.get('content-type') ?? '', /application\/json/)
    assert.doesNotMatch(await manifest.text(), /static manifest shadow/)

    const missing = await fetch(`${origin}/api/missing`)
    assert.equal(missing.status, 404)
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/)
    assert.doesNotMatch(await missing.text(), /static API shadow/)
  })

  it('excludes reserved paths from subpath static files and shell fallback', async () => {
    const origin = await productionApp('/console/')
    for (const path of ['api/agent/manifest', 'api/missing', 'health/internal', 'readiness', 'webrtc-signaling']) {
      const response = await fetch(`${origin}/console/${path}`)
      assert.equal(response.status, 404, path)
      assert.doesNotMatch(await response.text(), /static .* shadow|Application shell fixture/)
    }
    const shell = await fetch(`${origin}/console/automation`)
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /Application shell fixture/)
  })

  it('keeps health probes independent from JSON request bodies', async () => {
    const origin = await productionApp()
    const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const req = request(`${origin}/health`, {
        headers: { 'content-type': 'application/json', 'content-length': '1' }
      }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end('{')
    })
    assert.equal(result.status, 200)
    assert.deepEqual(JSON.parse(result.body), { success: true, status: 'ok' })
  })
})
