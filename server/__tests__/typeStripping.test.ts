import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeFixture,
  fixtureOrigin,
  sumCoordinates,
  type FixtureLabel,
  type FixturePoint,
} from './fixtures/typeStrippingFixture.ts';

test('node runs TypeScript test files directly with erasable syntax', () => {
  const point: FixturePoint = { ...fixtureOrigin, x: 2, y: 3 };
  assert.equal(sumCoordinates(point), 5);
  const label: FixtureLabel = 'native';
  assert.equal(describeFixture(label), 'type stripping fixture: native');
});
