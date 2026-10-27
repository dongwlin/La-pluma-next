import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveBoundedInteger } from '../numericQueryHelper.js';

const bounds = { defaultValue: 80, min: 1, max: 500 };

describe('resolveBoundedInteger', () => {
  it('falls back to the default for omitted or non-numeric input', () => {
    assert.equal(resolveBoundedInteger(undefined, bounds), 80);
    assert.equal(resolveBoundedInteger('abc', bounds), 80);
    assert.equal(resolveBoundedInteger('NaN', bounds), 80);
    assert.equal(resolveBoundedInteger(Number.NaN, bounds), 80);
    assert.equal(resolveBoundedInteger({}, bounds), 80);
  });

  it('falls back to the default for repeated query parameters', () => {
    assert.equal(resolveBoundedInteger(['80', '120'], bounds), 80);
  });

  it('accepts a single repeated value like its plain string form', () => {
    assert.equal(resolveBoundedInteger(['80'], bounds), 80);
    assert.equal(resolveBoundedInteger(['3.9'], bounds), 3);
  });

  it('treats non-finite magnitudes as invalid and falls back to the default', () => {
    assert.equal(resolveBoundedInteger('Infinity', bounds), 80);
    assert.equal(resolveBoundedInteger(Infinity, bounds), 80);
    assert.equal(resolveBoundedInteger('-Infinity', bounds), 80);
    assert.equal(resolveBoundedInteger(-Infinity, bounds), 80);
    assert.equal(resolveBoundedInteger('1e999', bounds), 80);
  });

  it('clamps oversized finite values to the configured maximum', () => {
    assert.equal(resolveBoundedInteger('1000000000', bounds), 500);
    assert.equal(resolveBoundedInteger('1e21', bounds), 500);
    assert.equal(resolveBoundedInteger(1000, bounds), 500);
  });

  it('clamps negatives and zero up to the minimum', () => {
    assert.equal(resolveBoundedInteger('-5', bounds), 1);
    assert.equal(resolveBoundedInteger(0, bounds), 1);
  });

  it('truncates decimals to integers', () => {
    assert.equal(resolveBoundedInteger('3.9', bounds), 3);
    assert.equal(resolveBoundedInteger('499.5', bounds), 499);
    assert.equal(resolveBoundedInteger(80.0000001, bounds), 80);
  });

  it('keeps valid in-range values untouched', () => {
    assert.equal(resolveBoundedInteger('80', bounds), 80);
    assert.equal(resolveBoundedInteger(1, bounds), 1);
    assert.equal(resolveBoundedInteger('500', bounds), 500);
  });

  it('honors caller-provided bounds', () => {
    const daysBounds = { defaultValue: 7, min: 1, max: 365 };
    assert.equal(resolveBoundedInteger(undefined, daysBounds), 7);
    assert.equal(resolveBoundedInteger('30', daysBounds), 30);
    assert.equal(resolveBoundedInteger('100000', daysBounds), 365);
  });
});
