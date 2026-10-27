import { setTimeout } from 'node:timers/promises'

export function registryError(message, retryable = false) {
  return Object.assign(new Error(message), { retryable })
}

export async function retryRegistry(operation, { pause = setTimeout } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!error.retryable || attempt === 2) throw error
      await pause(500 * 2 ** attempt)
    }
  }
}

// Read only manifests and image configs. A missing child/config is a broken
// existing image, never evidence that the requested version tag is absent.
export function createRegistryReader(image, {
  username = process.env.GITHUB_ACTOR,
  password = process.env.GHCR_TOKEN,
  request = fetch,
  pause,
} = {}) {
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9_.-]*\/la-pluma-next$/.test(image)) throw new Error('Invalid image name')
  const repository = image.slice('ghcr.io/'.length)
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ')
  const objects = new Map()
  let authorization

  const getJson = (url, headers, allowMissing = false) => retryRegistry(async () => {
    let response
    try {
      response = await request(url, { headers, signal: AbortSignal.timeout(15_000) })
    } catch (error) {
      throw registryError(`Registry request failed: ${new URL(url).pathname}`, error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name))
    }
    const missingResponse = allowMissing && response.status === 404
    if (!response.ok && !missingResponse) throw registryError(`Registry HTTP ${response.status}: ${new URL(url).pathname}`, response.status === 429 || response.status >= 500)
    let body
    try {
      body = await response.json()
    } catch (error) {
      throw registryError(`Invalid registry response: ${new URL(url).pathname}`, error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name))
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`Invalid registry JSON object: ${new URL(url).pathname}`)
    if (missingResponse) {
      const errors = body.errors
      if (Array.isArray(errors) && errors.length > 0 && errors.every(error => ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'].includes(error?.code))) return null
      throw registryError(`Registry HTTP 404: ${new URL(url).pathname}`)
    }
    return body
  }, { pause })

  const getAuthorization = () => {
    authorization ??= (async () => {
      const url = new URL('https://ghcr.io/token')
      url.searchParams.set('service', 'ghcr.io')
      url.searchParams.set('scope', `repository:${repository}:pull`)
      const headers = {}
      if (password) {
        if (!username) throw new Error('GHCR_TOKEN requires GITHUB_ACTOR')
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      }
      const body = await getJson(url, headers)
      const token = body.token || body.access_token
      if (typeof token !== 'string' || !token) throw new Error('Registry did not return a pull token')
      return `Bearer ${token}`
    })()
    return authorization
  }

  const getObject = async (type, reference, allowMissing = false) => {
    const headers = { Authorization: await getAuthorization(), Accept: accept }
    return getJson(`https://ghcr.io/v2/${repository}/${type}/${encodeURIComponent(reference)}`, headers, allowMissing)
  }
  const getDigest = (type, digest) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid registry object digest')
    const key = `${type}/${digest}`
    if (!objects.has(key)) objects.set(key, getObject(type, digest))
    return objects.get(key)
  }

  return async tag => {
    if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error('Invalid image tag')
    let manifest = await getObject('manifests', tag, true)
    if (manifest === null) return null
    for (let depth = 0; Array.isArray(manifest.manifests); depth++) {
      if (depth === 4) throw new Error('Too many nested image indexes')
      const platform = manifest.manifests.find(item => item.platform?.os === 'linux' && item.platform?.architecture === 'amd64')
      if (!platform) throw new Error(`Existing ${image}:${tag} has no linux/amd64 manifest`)
      manifest = await getDigest('manifests', platform.digest)
    }
    const config = await getDigest('blobs', manifest.config?.digest)
    return config.config?.Labels || {}
  }
}
