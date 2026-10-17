import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { MsEdgeTTS } from 'msedge-tts';
import { EdgeEngine, edgeRoute } from '../src/engines/edgeEngine';

// One local server stands in for both of Microsoft's ways in: /library is the
// URL msedge-tts builds itself, /bing the old host with the v2 token. A path in
// `refused` answers the WebSocket handshake with 403, any other path accepts it.
const refused = new Set<string>();
const seen: URL[] = [];
const sockets = new Set<Socket>();
const server = http.createServer();
server.on('upgrade', (req: http.IncomingMessage, socket: Socket) => {
  const url = new URL(req.url || '/', 'http://localhost');
  seen.push(url);
  if (refused.has(url.pathname)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  sockets.add(socket);
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
});

const lib = MsEdgeTTS as unknown as { WSS_URL: string };
const libUrl = lib.WSS_URL;
const bingUrl = edgeRoute.bingUrl;
const ready = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => {
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  lib.WSS_URL = `${base}/library`;
  edgeRoute.bingUrl = `${base}/bing`;
});
after(() => {
  lib.WSS_URL = libUrl;
  edgeRoute.bingUrl = bingUrl;
  for (const s of sockets) s.destroy();
  server.close();
});

async function warm(): Promise<string[]> {
  await ready;
  seen.length = 0;
  const engine = new EdgeEngine();
  try {
    await engine.warm('en-US-AriaNeural', 'en-US');
  } finally {
    engine.dispose();
  }
  return seen.map((u) => u.pathname);
}

test('a refused first way switches to the old host with the v2 token, and the next engine starts there', async () => {
  edgeRoute.current = 'msedgeservices';
  refused.clear();
  refused.add('/library');
  assert.deepEqual(await warm(), ['/library', '/bing']);
  assert.equal(edgeRoute.current, 'bing');
  const bing = seen[1].searchParams;
  assert.equal(bing.get('TrustedClientToken'), '6A5AA1D4EAFF4E9FB37E23D68491D6F4');
  assert.match(bing.get('Sec-MS-GEC') || '', /^[0-9A-F]{16}-[0-9A-F]{64}$/);
  assert.match(bing.get('Sec-MS-GEC-Version') || '', /^2-/);
  assert.match(seen[0].searchParams.get('Sec-MS-GEC-Version') || '', /^1-/);

  assert.deepEqual(await warm(), ['/bing']);
});

test('switches back when the old host refuses and the first way works again', async () => {
  edgeRoute.current = 'bing';
  refused.clear();
  refused.add('/bing');
  assert.deepEqual(await warm(), ['/bing', '/library']);
  assert.equal(edgeRoute.current, 'msedgeservices');
});

/** A ws:// URL on a port where nothing listens, like a host that is blocked. */
async function unreachable(path: string): Promise<string> {
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  return `ws://127.0.0.1:${port}${path}`;
}

test('an unreachable first way also switches to the other one', async () => {
  await ready;
  const open = lib.WSS_URL;
  lib.WSS_URL = await unreachable('/library');
  edgeRoute.current = 'msedgeservices';
  refused.clear();
  try {
    assert.deepEqual(await warm(), ['/bing']);
    assert.equal(edgeRoute.current, 'bing');
  } finally {
    lib.WSS_URL = open;
  }
});

test('one refusal does not strand the engines on a reserve that cannot be reached', async () => {
  await ready;
  const open = edgeRoute.bingUrl;
  edgeRoute.bingUrl = await unreachable('/bing');
  edgeRoute.current = 'msedgeservices';
  refused.clear();
  refused.add('/library');
  try {
    await assert.rejects(warm(), /ECONNREFUSED/);
    assert.equal(edgeRoute.current, 'msedgeservices');
    refused.clear();
    assert.deepEqual(await warm(), ['/library']);
  } finally {
    edgeRoute.bingUrl = open;
  }
});

test('fails with the reason when both ways are refused, and keeps the first way', async () => {
  edgeRoute.current = 'msedgeservices';
  refused.clear();
  refused.add('/library');
  refused.add('/bing');
  await assert.rejects(warm(), /403/);
  assert.deepEqual(
    seen.map((u) => u.pathname),
    ['/library', '/bing']
  );
  assert.equal(edgeRoute.current, 'msedgeservices');
});
