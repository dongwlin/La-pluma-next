// Publication and check selection policy, shared by the workflow entry points.
export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(value)
  if (!match || value.length > 128 || match[4]?.split('.').some(part => /^0\d+$/.test(part))) {
    throw new Error(`Invalid version: ${value}; expected MAJOR.MINOR.PATCH[-PRERELEASE], without build metadata`)
  }
  return { version: value, major: match[1], minor: match[2], patch: match[3], prerelease: Boolean(match[4]) }
}

export function releaseVersion(ref, packageVersion) {
  if (!ref.startsWith('refs/tags/')) return null
  if (!ref.startsWith('refs/tags/v')) throw new Error('Release tags must start with v')
  const version = parseVersion(ref.slice('refs/tags/v'.length))
  if (version.version !== packageVersion) throw new Error('Release tag must match the root package.json version')
  return version
}

export function movingTags(version) {
  if (version.prerelease) return []
  return [`${version.major}.${version.minor}`, version.major, 'latest']
}

export function shouldPromote(version, currentVersion) {
  if (version.prerelease) return false
  if (currentVersion === null) return true
  const current = parseVersion(currentVersion.replace(/^v/, ''))
  for (const part of ['major', 'minor', 'patch']) {
    const difference = BigInt(version[part]) - BigInt(current[part])
    if (difference !== 0n) return difference > 0n
  }
  return true
}

const isDocumentation = path => /(?:^|\/)[^/]+\.md$/i.test(path) || path.startsWith('docs/') || path.startsWith('screenshots/')
const isSharedBuildInput = path => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'].includes(path)
  || path.startsWith('.github/') || path.startsWith('scripts/ci/')
const isContainerInput = path => ['Dockerfile', '.dockerignore', 'docker-entrypoint.sh', 'docker-compose.yml'].includes(path)
const isPlatformInput = path => isSharedBuildInput(path) || isContainerInput(path)
  || ['client/package.json', 'server/package.json'].includes(path)

export function selectChecks(paths, { full = false, publish = false, mainPush = false } = {}) {
  const changed = paths.filter(path => !isDocumentation(path))
  const checks = full || changed.length > 0
  const browser = full || changed.some(path => isSharedBuildInput(path) || path.startsWith('client/') || path === 'scripts/visual-docker.mjs')
  const container = !mainPush && (full || changed.some(path => isSharedBuildInput(path) || isContainerInput(path)
    || path.startsWith('client/') && !path.startsWith('client/tests/') && !path.includes('.test.')
    || path.startsWith('server/') && !path.includes('/__tests__/')))
  const arm = full || changed.some(isPlatformInput)
  const matrix = { include: [{ runner: 'ubuntu-26.04', platform: 'linux/amd64', arch: 'amd64' }] }
  if (arm) matrix.include.push({ runner: 'ubuntu-26.04-arm', platform: 'linux/arm64', arch: 'arm64' })
  return { checks, browser, container, publish, matrix }
}

export function assertCheckResults(needs) {
  if (needs.prepare?.result !== 'success') throw new Error('prepare did not succeed')
  const outputs = needs.prepare.outputs
  for (const key of ['checks', 'browser', 'container', 'publish']) {
    if (!['true', 'false'].includes(outputs?.[key])) throw new Error(`Missing or invalid plan output: ${key}`)
  }
  const expected = {
    checks: outputs.checks === 'true',
    browser: outputs.browser === 'true',
    build: outputs.container === 'true' && outputs.publish === 'false',
    'release-build': outputs.publish === 'true',
  }
  for (const [job, required] of Object.entries(expected)) {
    const result = needs[job]?.result
    if (required ? result !== 'success' : result !== 'skipped') {
      throw new Error(`${job}: expected ${required ? 'success' : 'skipped'}, got ${result}`)
    }
  }
}
