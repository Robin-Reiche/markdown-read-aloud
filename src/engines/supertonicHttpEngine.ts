import * as http from 'node:http';
import type { Gender, TtsEngine } from '../types';

/** Fixed loopback default — the local `supertonic serve` port. */
export const SUPERTONIC_DEFAULT_ENDPOINT = 'http://127.0.0.1:7788';

/**
 * Hard cap on text per synthesis request. The webview targets ~240-character
 * sentences and the server chunks internally, so anything near this limit is
 * anomalous; capping bounds local CPU/memory per request.
 */
export const SUPERTONIC_MAX_INPUT_LENGTH = 2000;

/** Generous initial ceiling per short chunk; tighten after measuring real output. */
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT = 5_000;
const DEFAULT_TOTAL_TIMEOUT = 45_000;
const HEALTH_TIMEOUT = 3_000;

const WAV_MIMES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave']);

/** Built-in Supertonic voice styles are F1–F5 / M1–M5; pick the first per gender. */
export function supertonicVoiceForGender(gender: Gender): string {
  return gender === 'male' ? 'M1' : 'F1';
}

/** Supertonic takes a bare language code ('en'), or 'na' to let it fall back. */
export function supertonicLang(locale: string): string {
  const m = /^[a-z]{2,3}/i.exec(locale || '');
  return m ? m[0].toLowerCase() : 'na';
}

export interface SupertonicOptions {
  /** Loopback-only base URL; anything non-loopback is rejected at construction. */
  endpoint?: string;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Parse and validate the endpoint. This is a privacy boundary, not just input
 * hygiene: Supertonic mode promises document text never leaves the machine, so
 * only plain-http loopback origins with no credentials and no path are allowed.
 */
function parseEndpoint(endpoint: string): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Supertonic endpoint is not a valid URL');
  }
  if (url.protocol !== 'http:') throw new Error('Supertonic endpoint must use plain http on loopback');
  if (url.username || url.password) throw new Error('Supertonic endpoint must not contain credentials');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Supertonic endpoint must not contain a path');
  if (url.search || url.hash) throw new Error('Supertonic endpoint must not contain a query or fragment');
  const host = url.hostname.replace(/^\[|\]$/g, ''); // URL keeps IPv6 brackets; node:http wants them off
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('Supertonic endpoint must be a loopback address (127.0.0.1, localhost, or ::1)');
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Supertonic endpoint port is invalid');
  return { host, port };
}

interface HealthInfo {
  status: string;
  version?: string;
  voices_loaded?: number;
}

/**
 * Offline TTS via a user-started local Supertonic server (`supertonic serve`).
 * Speaks the server's OpenAI-compatible `POST /v1/audio/speech` API and returns
 * validated WAV audio.
 *
 * Fail-closed by design: any failure rejects; the engine never falls back to an
 * online service. Error messages never include the text being synthesized.
 * Requests are serialized (one at a time) so a slow local model isn't asked to
 * synthesize several chunks concurrently.
 */
export class SupertonicHttpEngine implements TtsEngine {
  readonly id = 'supertonic';
  readonly mime = 'audio/wav';

  private readonly host: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: SupertonicOptions = {}) {
    const { host, port } = parseEndpoint(options.endpoint ?? SUPERTONIC_DEFAULT_ENDPOINT);
    this.host = host;
    this.port = port;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  synth(text: string, voice: string, locale: string): Promise<Buffer> {
    if (!text.trim()) return Promise.resolve(Buffer.alloc(0));
    if (text.length > SUPERTONIC_MAX_INPUT_LENGTH) {
      return Promise.reject(new Error(`Supertonic input exceeds ${SUPERTONIC_MAX_INPUT_LENGTH} characters`));
    }
    const body = JSON.stringify({
      model: 'supertonic-3',
      input: text,
      voice,
      lang: supertonicLang(locale),
    });
    return this.enqueue(() => this.request(body));
  }

  /** Availability probe: GET /v1/health. Never sends document text. */
  async warm(_voice: string, _locale: string): Promise<void> {
    await this.health();
  }

  async health(): Promise<HealthInfo> {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const req = http.request(
        { host: this.host, port: this.port, path: '/v1/health', method: 'GET', timeout: HEALTH_TIMEOUT },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode !== 200) reject(new Error(`Supertonic health check returned HTTP ${res.statusCode}`));
            else resolve(Buffer.concat(chunks));
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('Supertonic health check timed out')));
      req.on('error', reject);
      req.end();
    });
    let info: HealthInfo;
    try {
      info = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('Supertonic health check returned an unexpected response');
    }
    if (info.status === 'loading') throw new Error('Supertonic server is still loading the model');
    if (info.status !== 'ok') throw new Error('Supertonic server is not ready');
    return info;
  }

  /** One request at a time, FIFO — a local CPU model shouldn't be synthesizing concurrently. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run as Promise<T>;
  }

  private request(body: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let received = 0;

      const req = http.request({
        host: this.host,
        port: this.port,
        path: '/v1/audio/speech',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          accept: 'audio/wav',
        },
        // NOTE: this is node's socket *idle* timeout, not a connect timeout. It
        // polices only the connect phase — it is disabled the moment the socket
        // is connected (below), because local synthesis legitimately keeps the
        // socket idle while the model computes. The total timer covers the rest.
        timeout: this.connectTimeoutMs,
      });

      req.on('socket', (socket) => {
        if (socket.connecting) socket.once('connect', () => req.setTimeout(0));
        else req.setTimeout(0); // reused keep-alive socket — already connected
      });

      const totalTimer = setTimeout(() => fail(new Error('Supertonic synthesis timed out')), this.totalTimeoutMs);

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        req.destroy(); // also destroys the response stream; no late data accumulates
        reject(err);
      };
      const succeed = (buf: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        resolve(buf);
      };

      req.on('timeout', () => fail(new Error('Supertonic connection timed out')));
      req.on('error', (e: NodeJS.ErrnoException) => {
        fail(e.code === 'ECONNREFUSED' ? new Error('Supertonic server is not running') : e);
      });

      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          return fail(new Error('Supertonic server sent a redirect, which is not allowed'));
        }
        if (status !== 200) {
          return fail(new Error(`Supertonic server returned HTTP ${status}`));
        }
        const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!WAV_MIMES.has(mime)) {
          return fail(new Error('Supertonic server returned an unexpected content-type'));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
          return fail(new Error('Supertonic response is too large'));
        }
        res.on('data', (c: Buffer) => {
          received += c.length;
          if (received > this.maxResponseBytes) {
            return fail(new Error('Supertonic response is too large'));
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
            return fail(new Error('Supertonic response is not valid WAV audio'));
          }
          succeed(buf);
        });
        res.on('error', fail);
      });

      req.end(body);
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}
