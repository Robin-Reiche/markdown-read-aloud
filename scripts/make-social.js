// Generates media/social-preview.png (1280x640) — the GitHub "Social preview" card
// (Settings > General > Social preview) and a reusable OG/share image. Brand language
// matches media/icon.svg: ink ground, teal "drench" icon, near-white wordmark, teal
// accents. Rendered with headless Google Chrome (set CHROME_PATH to override), then
// 2x-downscaled for crisp text/edges.
//
// Run: node scripts/make-social.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const W = 1280, H = 640;
const SCALE = 2;
const PAD_BOTTOM = 120; // viewport headroom so Chrome can't clip the bottom edge

const root = path.join(__dirname, '..');
const iconSvg = fs.readFileSync(path.join(root, 'media', 'icon.svg'), 'utf8');
const outPath = path.join(root, 'media', 'social-preview.png');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { execFileSync('command', ['-v', c], { stdio: 'ignore', shell: true }); return c; } catch {}
  }
  throw new Error('Google Chrome / Chromium not found. Set CHROME_PATH=/path/to/chrome');
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px}
  .card{
    width:${W}px;height:${H}px;position:relative;overflow:hidden;
    display:flex;align-items:center;gap:72px;padding:0 100px;
    background:radial-gradient(130% 150% at 16% 28%, #122421 0%, #0B1413 56%, #07110F 100%);
    font-family:'Ubuntu','Ubuntu Sans','DejaVu Sans',sans-serif;
  }
  /* faint speaker-arc echo emanating from the icon */
  .arcs{position:absolute;left:250px;top:50%;transform:translateY(-50%);opacity:.06}
  .icon{flex:0 0 300px;width:300px;height:300px;position:relative;z-index:2;
        filter:drop-shadow(0 26px 50px rgba(0,0,0,.5))}
  .icon svg{width:300px;height:300px;display:block}
  .text{position:relative;z-index:2}
  .kicker{font-size:21px;font-weight:600;letter-spacing:5px;color:#3FB9AC;margin-bottom:20px}
  .title{font-size:80px;font-weight:700;color:#F2FBF9;letter-spacing:-1.5px;line-height:1.02}
  .rule{width:92px;height:6px;background:#0C9488;border-radius:3px;margin:28px 0 26px}
  .tag{font-size:35px;font-weight:400;color:#A7C4BE;line-height:1.34;max-width:640px}
  .tag b{color:#F2FBF9;font-weight:600}
</style></head><body>
  <div class="card">
    <svg class="arcs" width="900" height="900" viewBox="0 0 900 900" fill="none"
         stroke="#0C9488" stroke-width="26" stroke-linecap="round">
      <path d="M450,210 A240,240 0 0 1 450,690"/>
      <path d="M450,120 A330,330 0 0 1 450,780"/>
      <path d="M450,30 A420,420 0 0 1 450,870"/>
    </svg>
    <div class="icon">${iconSvg}</div>
    <div class="text">
      <div class="kicker">VS&nbsp;CODE&nbsp;EXTENSION</div>
      <div class="title">Markdown Read&nbsp;Aloud</div>
      <div class="rule"></div>
      <div class="tag"><b>Free</b> neural text-to-speech for Markdown.<br>
        No API key, no sign-up — 75 languages.</div>
    </div>
  </div>
</body></html>`;

const tmpHtml = path.join(os.tmpdir(), 'mra-social-wrap.html');
const tmpPng = path.join(os.tmpdir(), 'mra-social-raw.png');
fs.writeFileSync(tmpHtml, html);

const chrome = findChrome();
execFileSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--force-device-scale-factor=${SCALE}`,
  `--window-size=${W},${H + PAD_BOTTOM}`,
  `--screenshot=${tmpPng}`,
  tmpHtml,
], { stdio: 'ignore' });

// Crop the top W*SCALE x H*SCALE region, then alpha-correct 2x box-downscale to WxH.
const raw = PNG.sync.read(fs.readFileSync(tmpPng));
const out = new PNG({ width: W, height: H });
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
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
    const o = (y * W + x) * 4;
    const n = SCALE * SCALE;
    out.data[o] = a ? Math.round(r / a) : 0;
    out.data[o + 1] = a ? Math.round(g / a) : 0;
    out.data[o + 2] = a ? Math.round(b / a) : 0;
    out.data[o + 3] = Math.round((a / n) * 255);
  }
}

fs.writeFileSync(outPath, PNG.sync.write(out, { deflateLevel: 9 }));
console.log(`Wrote media/social-preview.png (${W}x${H}) via ${chrome}`);
