import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { movingTags, parseVersion, shouldPromote } from './policy.mjs'

function docker(args, { allowMissing = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (allowMissing && /manifest unknown|manifest[^\n]*not found|name unknown/i.test(result.stderr)) return null
    throw new Error(`docker ${args[0]} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

export function publishImage({ image, version: value, revision, digests }, run = docker) {
  const version = parseVersion(value)
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9_.-]*\/la-pluma-next$/.test(image)) throw new Error('Invalid image name')
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid revision')
  if (digests.length !== 2 || digests.some(digest => !/^[a-f0-9]{64}$/.test(digest)) || new Set(digests).size !== 2) {
    throw new Error('Expected exactly two distinct platform digests')
  }

  const readImage = tag => {
    const reference = `${image}:${tag}`
    if (run(['pull', reference], { allowMissing: true }) === null) return null
    return JSON.parse(run(['image', 'inspect', '--format', '{{json .Config.Labels}}', reference])) || {}
  }

  const reference = `${image}:${version.version}`
  const existing = readImage(version.version)
  if (existing) {
    if (existing['org.opencontainers.image.revision'] !== revision || existing['org.opencontainers.image.version']?.replace(/^v/, '') !== value) {
      throw new Error(`Refusing to replace existing version ${value} with a different revision or version`)
    }
    console.log(`Reusing existing ${reference}; version tags are immutable`)
  } else {
    run(['buildx', 'imagetools', 'create', '--tag', reference, ...digests.map(digest => `${image}@sha256:${digest}`)])
  }

  // The workflow serializes this entire job. Re-read each moving tag while holding
  // that lock so a backport or a late run cannot roll a newer channel backward.
  for (const tag of movingTags(version)) {
    const current = readImage(tag)
    const currentVersion = current?.['org.opencontainers.image.version']
    if (current && !currentVersion) throw new Error(`Cannot determine the current version of ${tag}`)
    if (shouldPromote(version, currentVersion ?? null)) {
      run(['buildx', 'imagetools', 'create', '--tag', `${image}:${tag}`, reference])
    } else {
      console.log(`Keeping ${tag} at ${currentVersion}; ${value} is older`)
    }
  }
  run(['buildx', 'imagetools', 'inspect', reference])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishImage({
    image: process.env.IMAGE,
    version: process.env.VERSION,
    revision: process.env.REVISION,
    digests: readdirSync(process.env.DIGEST_DIRECTORY),
  })
}
