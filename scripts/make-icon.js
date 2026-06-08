// Generates media/icon.png (256x256) — a speaker + sound waves on a blue/purple
// rounded square. Hand-rolled PNG encoder (no image deps).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const buf = Buffer.alloc(S * S * 4); // RGBA

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // simple alpha-over onto existing
  const ea = buf[i + 3] / 255;
  const na = a / 255;
  const out = na + ea * (1 - na);
  if (out === 0) return;
  buf[i] = Math.round((r * na + buf[i] * ea * (1 - na)) / out);
  buf[i + 1] = Math.round((g * na + buf[i + 1] * ea * (1 - na)) / out);
  buf[i + 2] = Math.round((b * na + buf[i + 2] * ea * (1 - na)) / out);
  buf[i + 3] = Math.round(out * 255);
}

const lerp = (a, b, t) => a + (b - a) * t;
const inRoundedRect = (x, y, pad, radius) => {
  const lo = pad, hi = S - 1 - pad;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= radius * radius || x >= lo + radius || x <= hi - radius || y >= lo + radius || y <= hi - radius
    ? (Math.hypot(x - cx, y - cy) <= radius || (x > lo + radius && x < hi - radius) || (y > lo + radius && y < hi - radius))
    : false;
};

// Background: rounded square with vertical gradient (#7c3aed -> #2563eb)
const top = [124, 58, 237], bot = [37, 99, 235];
for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const r = Math.round(lerp(top[0], bot[0], t));
  const g = Math.round(lerp(top[1], bot[1], t));
  const b = Math.round(lerp(top[2], bot[2], t));
  for (let x = 0; x < S; x++) {
    if (inRoundedRect(x, y, 8, 52)) set(x, y, r, g, b, 255);
  }
}

// Speaker body (rect) + cone (triangle), white
function fillRect(x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, ...c);
}
function fillTri(p0, p1, p2, c) {
  const minX = Math.floor(Math.min(p0[0], p1[0], p2[0]));
  const maxX = Math.ceil(Math.max(p0[0], p1[0], p2[0]));
  const minY = Math.floor(Math.min(p0[1], p1[1], p2[1]));
  const maxY = Math.ceil(Math.max(p0[1], p1[1], p2[1]));
  const sign = (a, b, p) => (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x + 0.5, y + 0.5];
      const d1 = sign(p0, p1, p), d2 = sign(p1, p2, p), d3 = sign(p2, p0, p);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) set(x, y, ...c);
    }
  }
}
const WHITE = [255, 255, 255];
fillRect(74, 110, 104, 146, WHITE);
fillTri([104, 92], [104, 164], [150, 200], WHITE);
fillTri([104, 92], [150, 56], [150, 200], WHITE);

// Sound waves: two arcs to the right
function arc(cx, cy, radius, thick, a0, a1, c) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - cx, dy = y - cy;
    const rr = Math.hypot(dx, dy);
    if (Math.abs(rr - radius) > thick / 2) continue;
    let ang = Math.atan2(dy, dx) * 180 / Math.PI;
    if (ang >= a0 && ang <= a1) set(x, y, ...c);
  }
}
arc(150, 128, 40, 10, -52, 52, WHITE);
arc(150, 128, 66, 10, -48, 48, WHITE);

// ---- encode PNG ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter none
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);
const dir = path.join(__dirname, '..', 'media');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png);
console.log('Wrote media/icon.png', png.length, 'bytes');
