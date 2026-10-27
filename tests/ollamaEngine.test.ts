import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaEngine, OLLAMA_MAX_INPUT_LENGTH, finishStreamedWav, ollamaModel } from '../src/engines/ollamaEngine';
import { joinWav } from '../src/export/audioContainer';

/** The 44-byte header Ollama streams first: both size fields are 0xFFFFFFFF. */
function streamedWavHeader(): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(0xffffffff, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(0xffffffff, 40);
  return h;
}

interface Seen {
  show: any[];
  speech: any[];
}

type SpeechHandler = (body: any, res: http.ServerResponse) => void;

/** Streams the header and the samples in two writes, with no content-length, as Ollama does. */
const streamWav =
  (samples = 6): SpeechHandler =>
  (_body, res) => {
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.write(streamedWavHeader());
    res.end(Buffer.alloc(samples * 2, 1));
  };

/** A loopback stand-in for Ollama with `/api/show` and `/v1/audio/speech`. */
async function withOllama(
  opts: { show?: (body: any, res: http.ServerResponse) => void; speech?: SpeechHandler },
  run: (port: number, seen: Seen) => Promise<void>
) {
  const seen: Seen = { show: [], speech: [] };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      if (req.method === 'POST' && req.url === '/api/show') {
        seen.show.push(body);
        if (opts.show) return opts.show(body, res);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ capabilities: ['speech'], voices: ['default'] }));
      }
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        seen.speech.push(body);
        return (opts.speech ?? streamWav())(body, res);
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    await run(port, seen);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
}

function showStatus(status: number, payload: object): (body: any, res: http.ServerResponse) => void {
  return (_body, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

test('checks the model, then posts only fields Ollama accepts and returns a WAV with real sizes', async () => {
  await withOllama({}, async (port, seen) => {
    const engine = new OllamaEngine({ port });
    const buf = await engine.synth('Hello there.', 'phonon', 'de-DE');
    engine.dispose();
    assert.deepEqual(seen.show, [{ model: 'phonon' }]);
    // No voice and no language: Ollama answers unknown options with 400.
    assert.deepEqual(seen.speech, [{ model: 'phonon', input: 'Hello there.', response_format: 'wav' }]);
    assert.equal(buf.length, 44 + 12);
    assert.equal(buf.readUInt32LE(4), buf.length - 8);
    assert.equal(buf.readUInt32LE(40), 12);
    assert.equal(engine.id, 'ollama');
    assert.equal(engine.mime, 'audio/wav');
    // The export joins sentences, so the parts must read as ordinary WAV files.
    assert.equal(joinWav([buf, buf]).readUInt32LE(40), 24);
  });
});

test('checks each model once per engine, not once per sentence', async () => {
  await withOllama({}, async (port, seen) => {
    const engine = new OllamaEngine({ port });
    await engine.warm('phonon', '');
    await engine.synth('One.', 'phonon', 'en-US');
    await engine.synth('Two.', 'phonon', 'en-US');
    await engine.synth('Drei.', 'phonon:de', 'de-DE');
    engine.dispose();
    assert.deepEqual(
      seen.show.map((b) => b.model),
      ['phonon', 'phonon:de']
    );
    assert.equal(seen.speech.length, 3);
  });
});

test('a model that is not installed is reported and no text is sent', async () => {
  await withOllama({ show: showStatus(404, { error: "model 'phonon' not found" }) }, async (port, seen) => {
    const engine = new OllamaEngine({ port });
    await assert.rejects(engine.warm('phonon', ''), /"phonon" is not installed/);
    await assert.rejects(engine.synth('secret text', 'phonon', 'en-US'), (e: Error) => {
      assert.match(e.message, /not installed/);
      assert.ok(!e.message.includes('secret text'));
      return true;
    });
    engine.dispose();
    assert.equal(seen.speech.length, 0);
  });
});

test('a failed check is checked again, so Retry works once the model is pulled', async () => {
  let installed = false;
  await withOllama(
    {
      show: (_body, res) =>
        installed ? showStatus(200, { capabilities: ['speech'] })(_body, res) : showStatus(404, {})(_body, res),
    },
    async (port, seen) => {
      const engine = new OllamaEngine({ port });
      await assert.rejects(engine.warm('phonon', ''), /not installed/);
      installed = true;
      await engine.warm('phonon', '');
      engine.dispose();
      assert.equal(seen.show.length, 2);
    }
  );
});

test('refuses a model without the speech capability', async () => {
  await withOllama({ show: showStatus(200, { capabilities: ['completion'] }) }, async (port, seen) => {
    const engine = new OllamaEngine({ port });
    await assert.rejects(engine.synth('hello', 'llama3', 'en-US'), /not a speech model/);
    engine.dispose();
    assert.equal(seen.speech.length, 0);
  });
});

test('refuses a model Ollama forwards to the cloud, so the text never leaves the machine', async () => {
  await withOllama(
    { show: showStatus(200, { capabilities: ['speech'], remote_host: 'https://ollama.com:443', remote_model: 'phonon' }) },
    async (port, seen) => {
      const engine = new OllamaEngine({ port });
      await assert.rejects(engine.synth('secret text', 'phonon-remote', 'en-US'), /runs in the cloud/);
      engine.dispose();
      assert.equal(seen.speech.length, 0);
    }
  );
});

test('refuses cloud and malformed model names before any request', async () => {
  await withOllama({}, async (port, seen) => {
    const engine = new OllamaEngine({ port });
    await assert.rejects(engine.warm('phonon:cloud', ''), /runs in the cloud/);
    await assert.rejects(engine.warm('phonon-cloud', ''), /runs in the cloud/);
    await assert.rejects(engine.warm('phonon"; rm -rf', ''), /not valid/);
    await assert.rejects(engine.warm('', ''), /not valid/);
    engine.dispose();
    assert.equal(seen.show.length + seen.speech.length, 0);
  });
});

test('an empty setting falls back to the default model', () => {
  assert.equal(ollamaModel(undefined), 'phonon');
  assert.equal(ollamaModel('  '), 'phonon');
  assert.equal(ollamaModel(' phonon:de '), 'phonon:de');
});

test('rejects oversized input without a request and without echoing the text', async () => {
  await withOllama({}, async (port, seen) => {
    const engine = new OllamaEngine({ port });
    const secret = 'confidential-passphrase '.repeat(200);
    assert.ok(secret.length > OLLAMA_MAX_INPUT_LENGTH);
    await assert.rejects(engine.synth(secret, 'phonon', 'en-US'), (e: Error) => {
      assert.ok(!e.message.includes('confidential-passphrase'));
      return true;
    });
    engine.dispose();
    assert.equal(seen.show.length + seen.speech.length, 0);
  });
});

test('rejects an error status and keeps the input text out of the error', async () => {
  await withOllama(
    {
      speech: (_body, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'only speed 1 is supported' } }));
      },
    },
    async (port) => {
      const engine = new OllamaEngine({ port });
      await assert.rejects(engine.synth('secret text', 'phonon', 'en-US'), (e: Error) => {
        assert.match(e.message, /HTTP 400/);
        assert.ok(!e.message.includes('secret text'));
        return true;
      });
      engine.dispose();
    }
  );
});

test('rejects partial audio when Ollama closes the stream after a failure', async () => {
  await withOllama(
    {
      speech: (_body, res) => {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.write(Buffer.concat([streamedWavHeader(), Buffer.alloc(64)]));
        setTimeout(() => res.socket?.destroy(), 20);
      },
    },
    async (port) => {
      const engine = new OllamaEngine({ port });
      await assert.rejects(engine.synth('hello', 'phonon', 'en-US'), /Ollama stopped mid-request/);
      engine.dispose();
    }
  );
});

test('rejects a non-audio content-type', async () => {
  await withOllama(
    {
      speech: (_body, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>not audio</html>');
      },
    },
    async (port) => {
      const engine = new OllamaEngine({ port });
      await assert.rejects(engine.synth('hello', 'phonon', 'en-US'), /content-type/);
      engine.dispose();
    }
  );
});

test('aborts a stream that runs past the response cap', async () => {
  await withOllama(
    {
      speech: (_body, res) => {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.write(streamedWavHeader());
        const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 1);
        res.on('close', () => clearInterval(timer));
      },
    },
    async (port) => {
      const engine = new OllamaEngine({ port, maxResponseBytes: 256 * 1024 });
      await assert.rejects(engine.synth('hello', 'phonon', 'en-US'), /too large/);
      engine.dispose();
    }
  );
});

test('names a stopped Ollama instead of a raw connection error', async () => {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise((r) => srv.close(r));
  const engine = new OllamaEngine({ port });
  await assert.rejects(engine.warm('phonon', ''), /Ollama is not running/);
  engine.dispose();
});

test('finishStreamedWav rejects anything but the 44-byte PCM header', () => {
  assert.throws(() => finishStreamedWav(Buffer.from('this is not a wav file at all, not even close')), /not valid WAV/);
  const odd = streamedWavHeader();
  odd.writeUInt32LE(18, 16); // fmt chunk with an extension: data no longer starts at 36
  assert.throws(() => finishStreamedWav(odd), /not valid WAV/);
  const empty = finishStreamedWav(streamedWavHeader());
  assert.equal(empty.readUInt32LE(4), 36);
  assert.equal(empty.readUInt32LE(40), 0);
});
