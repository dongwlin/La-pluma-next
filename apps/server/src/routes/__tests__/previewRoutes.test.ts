import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildWebrtcBrowserProtocol } from '../../controllers/agentPreviewController.ts';
import { DEFAULT_DEVICE_ID } from '../../services/webrtcService.ts';
import { parseDeviceIdBody, parseOrientationBody } from '../../controllers/previewDto.ts';

describe('preview browser signaling contract', () => {
  it('keeps the same-origin endpoint and connect payload the browser consumes', () => {
    assert.deepEqual(buildWebrtcBrowserProtocol('preview-device'), {
      websocket: '/webrtc-signaling/connect_client?token=',
      connectMessage: { message_type: 'connect', device_id: 'preview-device' },
      requestOfferPayload: { type: 'request-offer', ip_preference: 'ipv4' },
      candidatePolicy: 'relay preferred / ipv4'
    });
  });
});

describe('preview request narrowing', () => {
  it('takes the device id from the body and falls back to the default', () => {
    assert.equal(parseDeviceIdBody({ deviceId: 'preview-device' }), 'preview-device');
    for (const body of [undefined, null, {}, { deviceId: '' }, { deviceId: 42 }, { deviceId: { id: 'nested' } }]) {
      assert.equal(parseDeviceIdBody(body), DEFAULT_DEVICE_ID);
    }
  });

  it('keeps the raw orientation and the legacy dryRun truthiness', () => {
    assert.deepEqual(parseOrientationBody({ orientation: 'landscape' }), { orientation: 'landscape', dryRun: false });
    assert.deepEqual(parseOrientationBody({ orientation: 'portrait', dryRun: true }), { orientation: 'portrait', dryRun: true });
    assert.deepEqual(parseOrientationBody({ orientation: 'auto', dryRun: false }), { orientation: 'auto', dryRun: false });
    assert.equal(parseOrientationBody({ dryRun: 1 }).dryRun, true);
    assert.deepEqual(parseOrientationBody(undefined), { orientation: undefined, dryRun: false });
  });
});
