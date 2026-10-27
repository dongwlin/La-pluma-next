import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCheckResults, movingTags, parseVersion, releaseVersion, selectChecks, shouldPromote } from './policy.mjs'
import { publishImage } from './publish-image.mjs'
import { registryError } from './registry.mjs'

test('only valid, matching release tags can publish; branches remain validation-only', () => {
  assert.equal(releaseVersion('refs/heads/main', '1.2.3'), null)
  assert.equal(releaseVersion('refs/tags/v1.2.3', '1.2.3').version, '1.2.3')
  assert.equal(releaseVersion('refs/tags/v1.2.3-rc.1', '1.2.3-rc.1').prerelease, true)
  for (const ref of ['refs/tags/v-test', 'refs/tags/1.2.3', 'refs/tags/v1.2.4']) assert.throws(() => releaseVersion(ref, '1.2.3'))
  for (const value of ['01.2.3', '1.2', '1.2.3-01', '1.2.3-rc.01', '1.2.3+', '1.2.3+build', '1.2.3-']) assert.throws(() => parseVersion(value), value)
})

test('prereleases never update stable channels; stable comparisons do not regress', () => {
  assert.deepEqual(movingTags(parseVersion('1.2.3-rc.1')), [])
  assert.deepEqual(movingTags(parseVersion('1.2.3')), ['1.2', '1', 'latest'])
  const version = parseVersion('1.2.10')
  for (const current of [null, '1.2.9', 'v1.2.9', '1.2.10', '1.2.10-rc.1', '1.2.9-rc.1']) assert.equal(shouldPromote(version, current), true)
  for (const current of ['1.2.11', '1.3.0', '2.0.0', '1.2.11-rc.1', '1.3.0-rc.1', '2.0.0-rc.1']) assert.equal(shouldPromote(version, current), false)
  assert.equal(shouldPromote(parseVersion('2.0.0-rc.1'), null), false)
  assert.throws(() => shouldPromote(version, 'main'))
})

test('documentation changes skip heavy jobs while mixed source changes remain covered', () => {
  const docs = selectChecks(['docs/guides/deployment.md', 'AGENTS.md', '.github/workflows/README.md'])
  assert.equal(docs.checks, false)
  assert.equal(docs.browser, false)
  assert.equal(docs.container, false)
  const client = selectChecks(['client/src/main.tsx', 'docs/README.md'])
  assert.equal(client.checks, true)
  assert.equal(client.browser, true)
  assert.equal(client.container, true)
  assert.equal(client.matrix.include.length, 1)
  const serverTests = selectChecks(['server/routes/__tests__/agentRoutes.test.js'])
  assert.equal(serverTests.checks, true)
  assert.equal(serverTests.browser, false)
  assert.equal(serverTests.container, false)
})

test('container, dependency and workflow changes exercise both native architectures', () => {
  for (const path of ['Dockerfile', '.dockerignore', 'docker-entrypoint.sh', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'server/package.json', 'client/package.json', '.github/workflows/ci.yml', 'scripts/ci/smoke-image.mjs']) {
    const plan = selectChecks([path])
    assert.equal(plan.container, true, path)
    assert.deepEqual(plan.matrix.include.map(item => item.platform), ['linux/amd64', 'linux/arm64'], path)
  }
  assert.equal(selectChecks(['server/server.js'], { mainPush: true }).container, false)
  const release = selectChecks([], { full: true, publish: true })
  assert.equal(release.browser, true)
  assert.equal(release.container, true)
  assert.equal(release.matrix.include.length, 2)
})

function results(plan) {
  return {
    prepare: { result: 'success', outputs: Object.fromEntries(Object.entries(plan).map(([key, value]) => [key, String(value)])) },
    checks: { result: plan.checks ? 'success' : 'skipped' },
    browser: { result: plan.browser ? 'success' : 'skipped' },
    build: { result: plan.container && !plan.publish ? 'success' : 'skipped' },
    'release-build': { result: plan.publish ? 'success' : 'skipped' },
  }
}

test('the required verify gate accepts only planned successes and explicit skips', () => {
  for (const plan of [selectChecks(['README.md']), selectChecks(['client/src/main.tsx']), selectChecks([], { full: true, publish: true })]) {
    const needs = results(plan)
    assert.doesNotThrow(() => assertCheckResults(needs))
    for (const name of Object.keys(needs)) {
      for (const failure of ['failure', 'cancelled']) assert.throws(() => assertCheckResults({ ...needs, [name]: { ...needs[name], result: failure } }), `${name}: ${failure}`)
      if (needs[name].result === 'success') assert.throws(() => assertCheckResults({ ...needs, [name]: { ...needs[name], result: 'skipped' } }), name)
    }
  }
  assert.throws(() => assertCheckResults({ prepare: { result: 'success', outputs: {} } }))
})

const image = 'ghcr.io/example/la-pluma-next'
const revision = 'a'.repeat(40)
const digests = ['b'.repeat(64), 'c'.repeat(64)]
const labels = (version, sha = revision) => ({ 'org.opencontainers.image.version': version, 'org.opencontainers.image.revision': sha })

function registry(initial = {}) {
  const images = new Map(Object.entries(initial))
  const writes = []
  return {
    images,
    writes,
    readImage: tag => images.has(tag) ? images.get(tag) || {} : null,
    run(args) {
      if (args[2] === 'create') {
        writes.push({ target: args[4], sources: args.slice(5) })
        const tag = args[4].split(':').at(-1)
        const source = args[5].split(':').at(-1)
        images.set(tag, images.get(source) || labels(tag))
      }
      return ''
    },
  }
}

test('a prerelease publishes only its immutable version, even if latest already exists', async () => {
  const fake = registry({ latest: labels('1.2.3') })
  await publishImage({ image, version: '2.0.0-rc.1', revision, digests }, fake)
  assert.deepEqual(fake.writes.map(write => write.target), [`${image}:2.0.0-rc.1`])
})

test('a backport advances its own minor channel without rolling major or latest backward', async () => {
  const fake = registry({ '1.2': labels('1.2.2'), 1: labels('1.3.0'), latest: labels('2.0.0') })
  await publishImage({ image, version: '1.2.3', revision, digests }, fake)
  assert.deepEqual(fake.writes.map(write => write.target), [`${image}:1.2.3`, `${image}:1.2`])
})

test('re-running a version reuses its original image; another revision is rejected', async () => {
  const fake = registry({ '1.2.3': labels('1.2.3') })
  await publishImage({ image, version: '1.2.3', revision, digests }, fake)
  assert.equal(fake.writes.some(write => write.target === `${image}:1.2.3`), false)
  assert(fake.writes.every(write => write.sources[0] === `${image}:1.2.3`))
  const conflict = registry({ '1.2.3': labels('1.2.3', 'd'.repeat(40)) })
  await assert.rejects(publishImage({ image, version: '1.2.3', revision, digests }, conflict), /Refusing to replace/)
  assert.deepEqual(conflict.writes, [])
  const unlabelled = registry({ '1.2.3': null })
  await assert.rejects(publishImage({ image, version: '1.2.3', revision, digests }, unlabelled), /Refusing to replace/)
  assert.deepEqual(unlabelled.writes, [])
})

test('missing architecture digests and registry failures cannot cause publication', async () => {
  const fake = registry()
  await assert.rejects(publishImage({ image, version: '1.2.3', revision, digests: digests.slice(0, 1) }, fake))
  assert.deepEqual(fake.writes, [])
  await assert.rejects(publishImage({ image, version: '1.2.3', revision, digests }, { ...fake, readImage: () => { throw new Error('Registry unavailable') } }), /Registry unavailable/)
  assert.deepEqual(fake.writes, [])
})

test('all channel labels are validated before the first registry write', async () => {
  for (const current of [{}, labels('main')]) {
    const fake = registry({ '1.2': labels('1.2.2'), 1: labels('1.2.2'), latest: current })
    await assert.rejects(publishImage({ image, version: '1.2.3', revision, digests }, fake), /Cannot determine|Invalid version/)
    assert.deepEqual(fake.writes, [])
  }
})

test('a failed channel write is recoverable without replacing the immutable version', async () => {
  const fake = registry({ '1.2': labels('1.2.2'), 1: labels('1.2.2'), latest: labels('1.2.2') })
  await assert.rejects(publishImage({ image, version: '1.2.3', revision, digests }, { ...fake, run(args) {
    if (args[4] === `${image}:latest`) throw new Error('Registry unavailable')
    return fake.run(args)
  } }), /Registry unavailable/)
  assert.equal(fake.images.get('latest')['org.opencontainers.image.version'], '1.2.2')
  await publishImage({ image, version: '1.2.3', revision, digests }, fake)
  assert.equal(fake.writes.filter(write => write.target === `${image}:1.2.3`).length, 1)
  for (const tag of ['1.2', '1', 'latest']) assert.equal(fake.images.get(tag)['org.opencontainers.image.version'], '1.2.3')
})

test('a transient lost acknowledgement can be retried safely', async () => {
  const fake = registry()
  const pauses = []
  let failOnce = true
  await publishImage({ image, version: '1.2.3', revision, digests }, { ...fake, pause: async ms => pauses.push(ms), run(args) {
    const result = fake.run(args)
    if (args[4] === `${image}:latest` && failOnce) {
      failOnce = false
      throw registryError('Connection reset after the registry accepted the tag', true)
    }
    return result
  } })
  assert.deepEqual(pauses, [500])
  assert.equal(fake.writes.filter(write => write.target === `${image}:1.2.3`).length, 1)
  assert.equal(fake.images.get('latest')['org.opencontainers.image.version'], '1.2.3')
})

test('transient retries are bounded and permission failures are not retried', async () => {
  for (const retryable of [true, false]) {
    const fake = registry()
    const pauses = []
    let attempts = 0
    await assert.rejects(publishImage({ image, version: '1.2.3', revision, digests }, {
      ...fake, pause: async ms => pauses.push(ms), run() { attempts++; throw registryError('Registry rejected the write', retryable) },
    }), /Registry rejected/)
    assert.equal(attempts, retryable ? 3 : 1)
    assert.deepEqual(pauses, retryable ? [500, 1000] : [])
    assert.deepEqual(fake.writes, [])
  }
})
