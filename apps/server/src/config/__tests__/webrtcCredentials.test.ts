import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_WEBRTC_PASSWORD,
  DEFAULT_WEBRTC_USERNAME,
  resolveWebrtcCredentials
} from '../webrtcCredentials.ts'

describe('WebRTC credential resolution', () => {
  it('keeps the upstream default account when nothing is configured', () => {
    const credentials = resolveWebrtcCredentials({})
    assert.deepEqual(credentials, {
      username: DEFAULT_WEBRTC_USERNAME,
      password: DEFAULT_WEBRTC_PASSWORD,
      source: 'default',
      usingDefault: true
    })
    assert.equal(credentials.username, 'admin')
    assert.equal(credentials.password, 'admin123')
  })

  it('uses configured values verbatim, including whitespace in a password', () => {
    const credentials = resolveWebrtcCredentials({
      LA_PLUMA_WEBRTC_USERNAME: 'console',
      LA_PLUMA_WEBRTC_PASSWORD: ' pass with spaces '
    })
    assert.deepEqual(credentials, {
      username: 'console',
      password: ' pass with spaces ',
      source: 'environment',
      usingDefault: false
    })
  })

  it('fills an unconfigured side from the documented default instead of inventing a value', () => {
    const passwordOnly = resolveWebrtcCredentials({ LA_PLUMA_WEBRTC_PASSWORD: 'custom-password' })
    assert.equal(passwordOnly.username, 'admin')
    assert.equal(passwordOnly.password, 'custom-password')
    assert.equal(passwordOnly.source, 'environment')

    const usernameOnly = resolveWebrtcCredentials({ LA_PLUMA_WEBRTC_USERNAME: 'custom-user' })
    assert.equal(usernameOnly.username, 'custom-user')
    assert.equal(usernameOnly.password, 'admin123')
  })

  it('treats empty values as unset and returns the same result for the same environment', () => {
    const env = { LA_PLUMA_WEBRTC_USERNAME: '', LA_PLUMA_WEBRTC_PASSWORD: '' }
    const first = resolveWebrtcCredentials(env)
    const second = resolveWebrtcCredentials(env)
    assert.deepEqual(first, second)
    assert.equal(first.usingDefault, true)
  })
})
