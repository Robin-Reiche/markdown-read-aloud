import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AudioCache } from '../src/player/audioCache';

function buf(bytes: number): ArrayBuffer {
  return new ArrayBuffer(bytes);
}

test('stores and returns entries by key', () => {
  const c = new AudioCache(10, 1024);
  const a = buf(4);
  c.set('k1', a);
  assert.equal(c.get('k1'), a);
  assert.equal(c.get('missing'), undefined);
});

test('evicts the least recently used entry when the entry cap is exceeded', () => {
  const c = new AudioCache(2, 1024);
  c.set('a', buf(1));
  c.set('b', buf(1));
  c.get('a'); // 'a' is now more recently used than 'b'
  c.set('c', buf(1));
  assert.equal(c.get('b'), undefined);
  assert.notEqual(c.get('a'), undefined);
  assert.notEqual(c.get('c'), undefined);
});

test('evicts entries until the total byte budget is respected', () => {
  const c = new AudioCache(10, 100);
  c.set('a', buf(40));
  c.set('b', buf(40));
  c.set('c', buf(40)); // 120 bytes total -> 'a' must go
  assert.equal(c.get('a'), undefined);
  assert.notEqual(c.get('b'), undefined);
  assert.notEqual(c.get('c'), undefined);
  assert.ok(c.totalBytes <= 100);
});

test('an entry larger than the whole byte budget is not stored', () => {
  const c = new AudioCache(10, 100);
  c.set('big', buf(101));
  assert.equal(c.get('big'), undefined);
  assert.equal(c.totalBytes, 0);
});

test('overwriting a key replaces its byte accounting instead of double-counting', () => {
  const c = new AudioCache(10, 100);
  c.set('a', buf(60));
  c.set('a', buf(30));
  assert.equal(c.totalBytes, 30);
});

test('clear empties entries and byte accounting', () => {
  const c = new AudioCache(10, 1024);
  c.set('a', buf(10));
  c.clear();
  assert.equal(c.get('a'), undefined);
  assert.equal(c.totalBytes, 0);
});
