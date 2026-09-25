import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isFeatureUpdate } from '../src/featureUpdate';

test('stays quiet after a first install', () => {
  assert.equal(isFeatureUpdate(undefined, '1.16.0'), false);
});

test('speaks up after an update from a version that did not store its version', () => {
  assert.equal(isFeatureUpdate(undefined, '1.17.0', true), true);
});

test('stays quiet after a bug-fix release', () => {
  assert.equal(isFeatureUpdate('1.16.0', '1.16.1'), false);
});

test('speaks up for a new minor or major version', () => {
  assert.equal(isFeatureUpdate('1.16.1', '1.17.0'), true);
  assert.equal(isFeatureUpdate('1.16.0', '2.0.0'), true);
});

test('stays quiet after a downgrade', () => {
  assert.equal(isFeatureUpdate('1.17.0', '1.16.0'), false);
});

test('compares versions as numbers, not text', () => {
  assert.equal(isFeatureUpdate('1.9.0', '1.10.0'), true);
});
