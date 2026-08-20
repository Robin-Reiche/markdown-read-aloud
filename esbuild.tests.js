// Bundles the unit tests for Node's built-in test runner.
//   node esbuild.tests.js && node --test .test-dist
// Tests cover the vscode-free modules (engines, caches); the esbuild bundle
// step doubles as a per-file check that test code stays free of `vscode` imports.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, 'tests');
const entryPoints = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(testDir, f));

esbuild
  .build({
    entryPoints,
    outdir: '.test-dist',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: 'inline',
    logLevel: 'warning',
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
