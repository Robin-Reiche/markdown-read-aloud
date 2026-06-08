import type { Block, Chunk } from './types';

const MAX_LEN = 240; // target characters per synthesized chunk
const MIN_LEN = 60; // merge sentences shorter than this with the next

/**
 * Turn speakable blocks into playback chunks (≈ one sentence each), using the
 * built-in, locale-aware Intl.Segmenter. Each chunk keeps its block's source
 * range so the editor can highlight while reading.
 */
export function chunkBlocks(blocks: Block[], locale: string): Chunk[] {
  const segLocale = locale.split('-')[0] || 'en';
  let segmenter: Intl.Segmenter | undefined;
  try {
    segmenter = new Intl.Segmenter(segLocale, { granularity: 'sentence' });
  } catch {
    segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  }

  const chunks: Chunk[] = [];
  let index = 0;

  for (const b of blocks) {
    const sentences = splitToSentences(b.text, segmenter);
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
    } else if (buf.length < MIN_LEN || buf.length + 1 + s.length <= MAX_LEN) {
      buf += ' ' + s;
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
