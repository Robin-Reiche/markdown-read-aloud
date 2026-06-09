// Copy only the country flags we actually need (one per curated locale region)
// from the flag-icons devDependency into media/flags/, which ships in the VSIX.
// Each flag is minified with SVGO (keeping viewBox so it still scales) — a few
// crest-heavy flags are 80-180 KB raw and dominate the package otherwise.
// Run: node scripts/copy-flags.mjs
import fs from 'fs';
import path from 'path';
import { optimize } from 'svgo';

// Lossless SVGO pass: strips editor metadata/comments and normalizes markup while
// keeping viewBox (preset-default in svgo v4 no longer removes it), so every flag still
// scales. The win is modest (~3%) because the heavy flags are detailed coats of arms
// whose path point-count — not bloat — is the cost; lossless can't reduce that without
// degrading the crest, which we don't want.
const svgoConfig = {
  multipass: true,
  plugins: ['preset-default'],
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const voices = JSON.parse(fs.readFileSync(path.join(root, 'src/data/voices.json'), 'utf8'));
const locales = Object.keys(voices.curated);

// region = the last 2-letter uppercase segment of the locale (de-DE -> DE,
// iu-Latn-CA -> CA, zh-CN-liaoning -> CN).
function regionOf(locale) {
  const parts = locale.split('-');
  for (let i = parts.length - 1; i >= 1; i--) {
    if (/^[A-Z]{2}$/.test(parts[i])) return parts[i].toLowerCase();
  }
  return null;
}

const codes = [...new Set(locales.map(regionOf).filter(Boolean))].sort();
const src = path.join(root, 'node_modules/flag-icons/flags/4x3');
const dst = path.join(root, 'media/flags');
fs.mkdirSync(dst, { recursive: true });

let copied = 0;
let rawBytes = 0;
let minBytes = 0;
const missing = [];
for (const c of codes) {
  const s = path.join(src, c + '.svg');
  if (fs.existsSync(s)) {
    const input = fs.readFileSync(s, 'utf8');
    let output = input;
    try {
      output = optimize(input, { ...svgoConfig, path: s }).data;
    } catch {
      // fall back to the raw flag if SVGO chokes on one
    }
    fs.writeFileSync(path.join(dst, c + '.svg'), output);
    rawBytes += Buffer.byteLength(input);
    minBytes += Buffer.byteLength(output);
    copied++;
  } else {
    missing.push(c);
  }
}
const kb = (n) => (n / 1024).toFixed(0);
console.log(
  `Flags: ${copied} copied to media/flags (of ${codes.length} regions), ` +
    `minified ${kb(rawBytes)} KB -> ${kb(minBytes)} KB.`
);
if (missing.length) console.log('Missing in flag-icons:', missing.join(', '));
