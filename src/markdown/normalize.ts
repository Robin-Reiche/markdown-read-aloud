/**
 * Light typographic cleanup for TTS. We deliberately keep this minimal: the Edge
 * neural voices already normalize numbers, currency, dates and most symbols well,
 * so we only remove things that would otherwise be read as garbage (leaked markdown
 * artifacts, zero-width chars) and tidy whitespace.
 */
export function normalizeForSpeech(input: string): string {
  let t = input;
  t = t.replace(/ /g, ' '); // non-breaking space
  t = t.replace(/[​-‍﻿]/g, ''); // zero-width chars
  t = t.replace(/[•◦▪▫‣⁃]/g, ' '); // stray list bullets
  t = t.replace(/\r\n?/g, '\n');
  t = t.replace(/\s*\n\s*/g, ' '); // soft line breaks inside a block -> space
  t = t.replace(/[ \t]{2,}/g, ' ');
  // collapse repeated punctuation that hurts prosody
  t = t.replace(/([!?.,;:])\1{2,}/g, '$1$1');
  return t.trim();
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWordy = (s: string) => /^[\p{L}\p{N}'’-]+$/u.test(s);

/**
 * User-defined pronunciation overrides (markdownReadAloud.pronunciations):
 * plain words match case-insensitively on word boundaries ("nginx" → "engine x"),
 * keys with other characters are replaced as literal substrings.
 */
export function applyPronunciations(text: string, map: Record<string, string> | undefined): string {
  if (!map) return text;
  let t = text;
  for (const [key, spoken] of Object.entries(map)) {
    if (!key || typeof spoken !== 'string') continue;
    try {
      if (isWordy(key)) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${reEscape(key)}(?![\\p{L}\\p{N}])`, 'giu');
        t = t.replace(re, spoken);
      } else {
        t = t.split(key).join(spoken);
      }
    } catch {
      /* a malformed key must never break synthesis */
    }
  }
  return t;
}

/**
 * A rough strip of markdown used ONLY for language detection (not for speech).
 * Removes code, urls and syntax noise so the detector sees mostly prose.
 */
export function stripForDetection(source: string): string {
  let t = source;
  t = t.replace(/^---\n[\s\S]*?\n---\n/, ''); // yaml frontmatter
  t = t.replace(/```[\s\S]*?```/g, ' '); // fenced code
  t = t.replace(/`[^`]*`/g, ' '); // inline code
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'); // links/images -> text
  t = t.replace(/https?:\/\/\S+/g, ' '); // bare urls
  t = t.replace(/[#>*_~`|>\-]/g, ' '); // markdown punctuation
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}
