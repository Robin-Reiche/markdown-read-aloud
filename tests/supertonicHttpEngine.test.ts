import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SupertonicHttpEngine,
  SUPERTONIC_MAX_INPUT_LENGTH,
  supertonicLang,
  supertonicVoiceForGender,
} from '../src/engines/supertonicHttpEngine';

/** Minimal valid WAV: RIFF header + fmt chunk + tiny data chunk. */
function wavFixture(dataBytes = 8): Buffer {
  const data = Buffer.alloc(dataBytes);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(44100 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, data]);
}

type Handler = (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void;

/** Start a loopback server; returns its endpoint and a way to swap the handler. */
async function withServer(handler: Handler, run: (endpoint: string, srv: http.Server) => Promise<void>) {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks), res));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`, srv);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

function okWavHandler(onBody?: (parsed: any, req: http.IncomingMessage) => void): Handler {
  return (req, body, res) => {
    if (onBody) onBody(JSON.parse(body.toString('utf8')), req);
    const wav = wavFixture();
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length) });
    res.end(wav);
  };
}

test('synth posts an OpenAI-compatible request and returns the WAV bytes', async () => {
  let seen: any = null;
  let path = '';
  await withServer(
    okWavHandler((parsed, req) => {
      seen = parsed;
      path = req.url || '';
    }),
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      const buf = await engine.synth('Hello there.', 'F1', 'en-US');
      engine.dispose();
      assert.equal(path, '/v1/audio/speech');
      assert.deepEqual(seen, { model: 'supertonic-3', input: 'Hello there.', voice: 'F1', lang: 'en' });
      assert.deepEqual(buf, wavFixture());
      assert.equal(engine.mime, 'audio/wav');
      assert.equal(engine.id, 'supertonic');
    }
  );
});

test('maps gender preference and BCP-47 locales to Supertonic parameters', () => {
  assert.equal(supertonicVoiceForGender('female'), 'F1');
  assert.equal(supertonicVoiceForGender('male'), 'M1');
  assert.equal(supertonicLang('en-US'), 'en');
  assert.equal(supertonicLang('pt-BR'), 'pt');
  assert.equal(supertonicLang(''), 'na');
});

test('empty or whitespace text resolves to an empty buffer without any HTTP request', async () => {
  let hits = 0;
  await withServer(
    okWavHandler(() => hits++),
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      const buf = await engine.synth('   \n', 'F1', 'en-US');
      engine.dispose();
      assert.equal(buf.length, 0);
      assert.equal(hits, 0);
    }
  );
});

test('rejects oversized input without echoing the text into the error', async () => {
  let hits = 0;
  await withServer(
    okWavHandler(() => hits++),
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      const secret = 'confidential-passphrase '.repeat(200); // > max input length
      assert.ok(secret.length > SUPERTONIC_MAX_INPUT_LENGTH);
      await assert.rejects(engine.synth(secret, 'F1', 'en-US'), (e: Error) => {
        assert.ok(!e.message.includes('confidential-passphrase'));
        return true;
      });
      engine.dispose();
      assert.equal(hits, 0);
    }
  );
});

test('rejects a non-200 response and keeps the input text out of the error', async () => {
  await withServer(
    (req, body, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"detail":"boom"}');
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      await assert.rejects(engine.synth('secret text', 'F1', 'en-US'), (e: Error) => {
        assert.match(e.message, /500/);
        assert.ok(!e.message.includes('secret text'));
        return true;
      });
      engine.dispose();
    }
  );
});

test('rejects redirects instead of following them', async () => {
  let followed = false;
  await withServer(
    (req, body, res) => {
      if (req.url === '/v1/audio/speech') {
        res.writeHead(302, { location: '/elsewhere' });
        res.end();
      } else {
        followed = true;
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(wavFixture());
      }
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      await assert.rejects(engine.synth('hello', 'F1', 'en-US'), /redirect/i);
      engine.dispose();
      assert.equal(followed, false);
    }
  );
});

test('rejects a non-audio content-type', async () => {
  await withServer(
    (req, body, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not audio</html>');
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      await assert.rejects(engine.synth('hello', 'F1', 'en-US'), /content-type|MIME/i);
      engine.dispose();
    }
  );
});

test('rejects a body that is not RIFF/WAVE audio', async () => {
  await withServer(
    (req, body, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(Buffer.from('this is not a wav file at all'));
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      await assert.rejects(engine.synth('hello', 'F1', 'en-US'), /WAV|RIFF/i);
      engine.dispose();
    }
  );
});

test('rejects when the declared content-length exceeds the response cap', async () => {
  await withServer(
    (req, body, res) => {
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(64 * 1024 * 1024) });
      res.end(wavFixture());
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint, maxResponseBytes: 1024 * 1024 });
      await assert.rejects(engine.synth('hello', 'F1', 'en-US'), /large|size/i);
      engine.dispose();
    }
  );
});

test('aborts a chunked response that streams past the response cap', async () => {
  await withServer(
    (req, body, res) => {
      // no content-length: stream forever until the client gives up
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.write(wavFixture(1024));
      const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 1);
      res.on('close', () => clearInterval(timer));
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint, maxResponseBytes: 256 * 1024 });
      await assert.rejects(engine.synth('hello', 'F1', 'en-US'), /large|size/i);
      engine.dispose();
    }
  );
});

test('slow synthesis is not killed by the connect timeout (idle socket while the model computes)', async () => {
  await withServer(
    (req, body, res) => {
      // connection succeeds instantly, then the "model" computes with no bytes flowing
      setTimeout(() => {
        const wav = wavFixture();
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length) });
        res.end(wav);
      }, 300);
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint, connectTimeoutMs: 100, totalTimeoutMs: 5000 });
      const buf = await engine.synth('hello', 'F1', 'en-US');
      engine.dispose();
      assert.deepEqual(buf, wavFixture());
    }
  );
});

test('times out when the server never answers', async () => {
  await withServer(
    () => {
      /* accept the request, never respond */
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint, totalTimeoutMs: 200 });
      const started = Date.now();
      await assert.rejects(engine.synth('hello', 'F1', 'en-US'), /timeout|timed out/i);
      assert.ok(Date.now() - started < 5000);
      engine.dispose();
    }
  );
});

test('serializes concurrent synth calls into one request at a time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await withServer(
    (req, body, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        const wav = wavFixture();
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length) });
        res.end(wav);
      }, 30);
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      await Promise.all([
        engine.synth('one', 'F1', 'en-US'),
        engine.synth('two', 'F1', 'en-US'),
        engine.synth('three', 'F1', 'en-US'),
      ]);
      engine.dispose();
      assert.equal(maxInFlight, 1);
    }
  );
});

test('constructor rejects non-loopback, credentialed, non-http, or path-bearing endpoints', () => {
  const bad = [
    'http://example.com:7788',
    'http://192.168.1.10:7788',
    'http://user:pass@127.0.0.1:7788',
    'https://127.0.0.1:7788',
    'http://127.0.0.1:7788/steal',
    'not a url',
  ];
  for (const endpoint of bad) {
    assert.throws(() => new SupertonicHttpEngine({ endpoint }), undefined, `should reject ${endpoint}`);
  }
  // loopback spellings are fine
  new SupertonicHttpEngine({ endpoint: 'http://127.0.0.1:7788' }).dispose();
  new SupertonicHttpEngine({ endpoint: 'http://localhost:7788' }).dispose();
  new SupertonicHttpEngine({ endpoint: 'http://[::1]:7788/' }).dispose();
});

test('warm resolves when /v1/health reports ok', async () => {
  await withServer(
    (req, body, res) => {
      assert.equal(req.url, '/v1/health');
      assert.equal(req.method, 'GET');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', model: 'supertonic-3', version: '1.3.1', voices_loaded: 10 }));
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      await engine.warm('F1', 'en-US');
      engine.dispose();
    }
  );
});

test('warm rejects while the model is still loading', async () => {
  await withServer(
    (req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'loading', version: '1.3.1' }));
    },
    async (endpoint) => {
      const engine = new SupertonicHttpEngine({ endpoint });
      await assert.rejects(engine.warm('F1', 'en-US'), /loading/i);
      engine.dispose();
    }
  );
});

test('warm rejects when nothing is listening', async () => {
  // grab a port and close it so it is very likely unused
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  const engine = new SupertonicHttpEngine({ endpoint: `http://127.0.0.1:${port}` });
  await assert.rejects(engine.warm('F1', 'en-US'));
  engine.dispose();
});
