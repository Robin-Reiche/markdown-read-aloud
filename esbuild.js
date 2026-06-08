// Bundles the extension (and, when present, the Supertonic worker) with esbuild.
//   node esbuild.js [--production] [--watch]
const esbuild = require('esbuild');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    external: ['vscode'],
  },
];

// The Supertonic worker runs in a separate (system-node) process and uses the
// native onnxruntime-node addon, which must stay external (not bundled).
if (fs.existsSync('src/supertonic/worker.ts')) {
  builds.push({
    ...common,
    entryPoints: ['src/supertonic/worker.ts'],
    outfile: 'dist/supertonic-worker.js',
    format: 'cjs',
    external: ['vscode', 'onnxruntime-node'],
  });
}

async function main() {
  if (watch) {
    const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[esbuild] watching…');
  } else {
    await Promise.all(builds.map((b) => esbuild.build(b)));
    console.log('[esbuild] build complete');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
