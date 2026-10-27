import assert from 'node:assert/strict'
import test from 'node:test'
import { createRegistryReader } from './registry.mjs'

const image = 'ghcr.io/example/la-pluma-next'
const manifestDigest = `sha256:${'a'.repeat(64)}`
const configDigest = `sha256:${'b'.repeat(64)}`
const index = { manifests: [
  { digest: manifestDigest, platform: { os: 'linux', architecture: 'amd64' } },
  { digest: `sha256:${'c'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' } },
] }
const manifest = { config: { digest: configDigest } }
const labels = { 'org.opencontainers.image.version': '1.2.3', 'org.opencontainers.image.revision': 'd'.repeat(40) }
const missing = { errors: [{ code: 'MANIFEST_UNKNOWN', message: 'manifest unknown' }] }
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })

function reader(handler) {
  const calls = []
  const pauses = []
  const read = createRegistryReader(image, {
    username: 'ci-user', password: 'ci-password',
    pause: async ms => pauses.push(ms),
    request: async (url, options) => {
      const path = decodeURIComponent(new URL(url).pathname)
      calls.push(path)
      if (path === '/token') {
        assert.equal(options.headers.Authorization, `Basic ${Buffer.from('ci-user:ci-password').toString('base64')}`)
        assert.equal(new URL(url).searchParams.get('scope'), 'repository:example/la-pluma-next:pull')
        return response({ token: 'ci-registry-token' })
      }
      assert.equal(options.headers.Authorization, 'Bearer ci-registry-token')
      return handler(path, calls)
    },
  })
  return { read, calls, pauses }
}

test('only an exact tag lookup with a structured 404 missing response means absence', async () => {
  const fake = reader(() => response(missing, 404))
  assert.equal(await fake.read('1.2.3'), null)
  assert.equal(fake.calls.length, 2)
  for (const [body, status] of [[missing, 401], [{ errors: [{ code: 'DENIED', message: 'manifest not found' }] }, 404], [{ message: 'manifest not found' }, 404]]) {
    const denied = reader(() => response(body, status))
    await assert.rejects(denied.read('1.2.3'), /Registry HTTP/)
    assert.deepEqual(denied.pauses, [])
  }
})

test('an existing tag with a missing platform manifest or config fails closed', async () => {
  for (const missingType of ['manifest', 'config']) {
    const fake = reader(path => {
      if (path.endsWith('/manifests/1.2.3')) return response(index)
      if (path.endsWith(`/manifests/${manifestDigest}`)) return response(missingType === 'manifest' ? missing : manifest, missingType === 'manifest' ? 404 : 200)
      return response(missing, 404)
    })
    await assert.rejects(fake.read('1.2.3'), /Registry HTTP 404/)
    assert.deepEqual(fake.pauses, [])
  }
})

test('metadata reads share authentication and digest objects without pulling layers', async () => {
  const fake = reader(path => {
    if (path.endsWith(`/manifests/${manifestDigest}`)) return response(manifest)
    if (path.endsWith(`/blobs/${configDigest}`)) return response({ config: { Labels: labels } })
    return response(index)
  })
  const results = await Promise.all(['1.2.3', '1.2', '1', 'latest'].map(fake.read))
  for (const result of results) assert.deepEqual(result, labels)
  assert.equal(fake.calls.filter(path => path === '/token').length, 1)
  assert.equal(fake.calls.filter(path => path.endsWith(manifestDigest)).length, 1)
  assert.equal(fake.calls.filter(path => path.endsWith(configDigest)).length, 1)
  assert.equal(fake.calls.length, 7)
})

test('single-platform images are supported and missing labels stay visible to preflight', async () => {
  for (const config of [{ config: { Labels: labels } }, { config: {} }]) {
    const fake = reader(path => response(path.endsWith('/manifests/1.2.3') ? manifest : config))
    assert.deepEqual(await fake.read('1.2.3'), config.config.Labels || {})
  }
})

test('HTTP 503 and network failures retry without treating the image as absent', async () => {
  for (const failure of [() => response({}, 503), () => { throw new TypeError('fetch failed') }]) {
    let attempts = 0
    const fake = reader(path => {
      if (path.endsWith('/manifests/1.2.3')) return ++attempts === 1 ? failure() : response(manifest)
      return response({ config: { Labels: labels } })
    })
    assert.deepEqual(await fake.read('1.2.3'), labels)
    assert.equal(attempts, 2)
    assert.deepEqual(fake.pauses, [500])
  }
  const unavailable = reader(() => response({}, 503))
  await assert.rejects(unavailable.read('1.2.3'), /Registry HTTP 503/)
  assert.deepEqual(unavailable.pauses, [500, 1000])
})

test('a malformed or incompatible existing image cannot be treated as absent', async () => {
  for (const object of [null, [], 'manifest not found', {}, { manifests: [] }, { config: { digest: 'invalid' } }]) {
    const fake = reader(() => response(object))
    await assert.rejects(fake.read('1.2.3'), /Invalid registry JSON object|Invalid registry object digest|no linux\/amd64 manifest/)
  }
})
