import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureOrigin, sumCoordinates } from './fixtures/typeStrippingFixture.ts';

test('node resolves JavaScript imports to native TypeScript modules', () => {
  assert.equal(sumCoordinates(fixtureOrigin), 0);
  assert.equal(typeof sumCoordinates, 'function');
  assert.equal(typeof fixtureOrigin.x, 'number');
});
