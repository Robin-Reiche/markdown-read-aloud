import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { secMsGecV2 } from '../src/engines/edgeToken';

// Produced by generate_sec_ms_gec_v2 of rany2/edge-tts 7.3.1 for these timestamps.
const UPSTREAM: [number, string][] = [
  [0, '52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6'],
  [1760700000, 'CF13759BA0B77A18-D322BD7241343C37E258AF0ECB9BCB2B3F00FC12BCF6DF0A95AD973B0FB5D323'],
  [1797000000.5, '3298E4C826B51F7F-28F0607C4078688F95820B34B8BC8919F9CC126FF56D4A86C3076F6D54CDE289'],
];

test('matches the v2 token of rany2/edge-tts', () => {
  for (const [unix, token] of UPSTREAM) assert.equal(secMsGecV2(unix), token, `unix ${unix}`);
});

test('stays the same within a 5-minute window and changes after it', () => {
  assert.equal(secMsGecV2(1760700299.9), secMsGecV2(1760700000));
  assert.notEqual(secMsGecV2(1760700300), secMsGecV2(1760700000));
});
