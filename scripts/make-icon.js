// Regenerates media/icon.png (256x256 RGBA) from media/icon.svg — the icon source
// of truth ("teal drench": Markdown M + down-arrow + speaker arcs on a teal squircle).
// package.json "icon" must be a PNG (VS Code disallows SVG there), so this renders the
// SVG to PNG with headless Google Chrome, then downscales 2x for crisp edges.
//
// Run: node scripts/make-icon.js   (needs Google Chrome; set CHROME_PATH to override)
//
// Render gotcha (documented): a plain --window-size=256,256 screenshot clips the bottom
// of the squircle in headless Chrome. Fix: render into a TALLER window and crop the top.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const SIZE = 256;       // final icon size
const SCALE = 2;        // supersample factor for crisp edges
const PAD_BOTTOM = 120; // extra viewport height (CSS px) so Chrome can't clip the squircle's bottom

const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'media', 'icon.svg');
const outPath = path.join(root, 'media', 'icon.png');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const c of candidates) {
    try { execFileSync('command', ['-v', c], { stdio: 'ignore', shell: true }); return c; } catch {}
  }
  throw new Error('Google Chrome / Chromium not found. Set CHROME_PATH=/path/to/chrome');
}

const svg = fs.readFileSync(svgPath, 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block;width:${SIZE}px;height:${SIZE}px}
</style></head><body>${svg}</body></html>`;

const tmpHtml = path.join(os.tmpdir(), 'mra-icon-wrap.html');
const tmpPng = path.join(os.tmpdir(), 'mra-icon-raw.png');
fs.writeFileSync(tmpHtml, html);

const chrome = findChrome();
execFileSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--force-device-scale-factor=${SCALE}`,
  `--window-size=${SIZE},${SIZE + PAD_BOTTOM}`,
  '--default-background-color=00000000',
  `--screenshot=${tmpPng}`,
  tmpHtml,
], { stdio: 'ignore' });

// Crop the top SIZE*SCALE square, then alpha-correct 2x box-downscale to SIZE.
const raw = PNG.sync.read(fs.readFileSync(tmpPng));
const big = SIZE * SCALE;
const out = new PNG({ width: SIZE, height: SIZE });
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const sx = x * SCALE + dx, sy = y * SCALE + dy;
        const i = (sy * raw.width + sx) * 4;
        const sa = raw.data[i + 3] / 255;
        r += raw.data[i] * sa; g += raw.data[i + 1] * sa; b += raw.data[i + 2] * sa;
        a += sa;
      }
    }
    const o = (y * SIZE + x) * 4;
    const n = SCALE * SCALE;
    out.data[o] = a ? Math.round(r / a) : 0;        // un-premultiply
    out.data[o + 1] = a ? Math.round(g / a) : 0;
    out.data[o + 2] = a ? Math.round(b / a) : 0;
    out.data[o + 3] = Math.round((a / n) * 255);
  }
}

// Sanity: the squircle's bottom-center must be opaque (not clipped).
const bc = ((SIZE - 3) * SIZE + (SIZE >> 1)) * 4;
if (out.data[bc + 3] < 200) {
  throw new Error('Render looks clipped (bottom-center is transparent). Increase PAD_BOTTOM.');
}

fs.writeFileSync(outPath, PNG.sync.write(out, { deflateLevel: 9 }));
console.log(`Wrote media/icon.png (${SIZE}x${SIZE}) from media/icon.svg via ${chrome}`);
