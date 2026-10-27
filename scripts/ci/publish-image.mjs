import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { movingTags, parseVersion, shouldPromote } from './policy.mjs'
import { createRegistryReader, registryError, retryRegistry } from './registry.mjs'

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 })
  if (result.error) throw registryError(`docker ${args[0]} failed: ${result.error.message}`, result.error.code === 'ETIMEDOUT')
  if (result.status !== 0) {
    const retryable = /\b(?:429|500|502|503|504)\b|toomanyrequests|too many requests|timeout|timed? out|deadline exceeded|connection reset|connection refused|unexpected EOF|temporarily unavailable|network is unreachable/i.test(result.stderr)
    throw registryError(`docker ${args[0]} failed: ${result.stderr}`, retryable)
  }
  return result.stdout.trim()
}

export async function publishImage({ image, version: value, revision, digests }, dependencies = {}) {
  const version = parseVersion(value)
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9_.-]*\/la-pluma-next$/.test(image)) throw new Error('Invalid image name')
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid revision')
  if (digests.length !== 2 || digests.some(digest => !/^[a-f0-9]{64}$/.test(digest)) || new Set(digests).size !== 2) {
    throw new Error('Expected exactly two distinct platform digests')
  }

  const readImage = dependencies.readImage || createRegistryReader(image)
  const run = args => retryRegistry(() => (dependencies.run || docker)(args), { pause: dependencies.pause })

  const reference = `${image}:${version.version}`
  const tags = movingTags(version)
  // The workflow holds the publication lock throughout these reads and writes.
  // Finish all reads and validation before exposing any new version or channel.
  const [existing, ...channels] = await Promise.all([version.version, ...tags].map(readImage))
  if (existing) {
    if (existing['org.opencontainers.image.revision'] !== revision || existing['org.opencontainers.image.version']?.replace(/^v/, '') !== value) {
      throw new Error(`Refusing to replace existing version ${value} with a different revision or version`)
    }
  }
  const promotions = tags.map((tag, index) => {
    const current = channels[index]
    const currentVersion = current?.['org.opencontainers.image.version']
    if (current && !currentVersion) throw new Error(`Cannot determine the current version of ${tag}`)
    return { tag, currentVersion, advance: shouldPromote(version, currentVersion ?? null) }
  })

  if (existing) {
    console.log(`Reusing existing ${reference}; version tags are immutable`)
  } else {
    await run(['buildx', 'imagetools', 'create', '--tag', reference, ...digests.map(digest => `${image}@sha256:${digest}`)])
  }
  for (const { tag, currentVersion, advance } of promotions) {
    if (advance) {
      await run(['buildx', 'imagetools', 'create', '--tag', `${image}:${tag}`, reference])
    } else {
      console.log(`Keeping ${tag} at ${currentVersion}; ${value} is older`)
    }
  }
  await run(['buildx', 'imagetools', 'inspect', reference])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await publishImage({
    image: process.env.IMAGE,
    version: process.env.VERSION,
    revision: process.env.REVISION,
    digests: readdirSync(process.env.DIGEST_DIRECTORY),
  })
}
