import type { Block, Chunk } from './types';

const MAX_LEN = 240; // target characters per synthesized chunk

/**
 * Turn speakable blocks into playback chunks (≈ one sentence each), using the
 * built-in, locale-aware Intl.Segmenter. Each chunk keeps its block's source
 * range so the editor can highlight while reading.
 */
export function chunkBlocks(blocks: Block[], fallbackLocale: string): Chunk[] {
  const segCache = new Map<string, Intl.Segmenter>();
  const segFor = (locale: string): Intl.Segmenter => {
    const base = locale.split('-')[0] || 'en';
    let s = segCache.get(base);
    if (!s) {
      try {
        s = new Intl.Segmenter(base, { granularity: 'sentence' });
      } catch {
        s = new Intl.Segmenter('en', { granularity: 'sentence' });
      }
      segCache.set(base, s);
    }
    return s;
  };

  const chunks: Chunk[] = [];
  let index = 0;

  for (const b of blocks) {
    const locale = b.locale || fallbackLocale;
    const sentences = splitToSentences(b.text, segFor(locale));
    for (const text of sentences) {
      chunks.push({
        index: index++,
        text,
        locale,
        kind: b.kind,
        blockStartOffset: b.startOffset,
        blockEndOffset: b.endOffset,
        headingLevel: b.headingLevel,
      });
    }
  }
  return chunks;
}

function splitToSentences(text: string, segmenter: Intl.Segmenter): string[] {
  const raw = [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = '';
  };

  for (const s of raw) {
    if (s.length > MAX_LEN) {
      // very long sentence: flush buffer, then split on clause boundaries
      flush();
      out.push(...splitLong(s));
      continue;
    }
    if (!buf) {
      buf = s;
    } else if (buf.length + 1 + s.length <= MAX_LEN) {
      buf += ' ' + s; // combine consecutive short sentences up to the target
    } else {
      flush();
      buf = s;
    }
  }
  flush();
  return out;
}

function splitLong(s: string): string[] {
  const parts = s.split(/(?<=[,;:—–])\s+/);
  const out: string[] = [];
  let buf = '';
  for (const p of parts) {
    if (!buf) buf = p;
    else if (buf.length + 1 + p.length <= MAX_LEN) buf += ' ' + p;
    else {
      out.push(buf.trim());
      buf = p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  // last resort: hard wrap anything still too long
  return out.flatMap((part) =>
    part.length <= MAX_LEN * 1.5 ? [part] : hardWrap(part, MAX_LEN)
  );
}

function hardWrap(s: string, size: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let buf = '';
  for (const w of words) {
    if (w.length > size) {
      // a single token longer than the limit (e.g. a huge URL): hard-slice it
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < w.length; i += size) out.push(w.slice(i, i + size));
      continue;
    }
    if (buf && buf.length + 1 + w.length > size) {
      out.push(buf);
      buf = w;
    } else {
      buf = buf ? buf + ' ' + w : w;
    }
  }
  if (buf) out.push(buf);
  return out;
}
