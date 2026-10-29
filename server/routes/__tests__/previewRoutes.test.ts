import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_DEVICE_ID } from '../../services/webrtcService.ts';
import { parseDeviceIdBody, parseOrientationBody } from '../previewDto.ts';

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
