# Contributing

Thanks for your interest in **Markdown Read Aloud**! Issues and pull requests are welcome.

## Prerequisites

- Node.js 20+
- VS Code 1.90+

## Setup

```bash
npm ci
```

## Develop

```bash
npm run watch       # rebuild the bundle on change (esbuild)
npm run typecheck   # tsc --noEmit
```

Then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the
extension loaded. Open a `.md` file and run **Read Aloud: Read Whole Document**.

## Build & package

```bash
npm run build                 # production esbuild bundle -> dist/
node scripts/copy-flags.mjs   # generate media/flags/ from the flag-icons dep
npm run package               # produce a .vsix locally (vsce package)
```

`media/flags/` and `dist/` are generated and git-ignored; `copy-flags.mjs` and the build
run automatically on `vscode:prepublish`, so you don't need to commit those artifacts.

## Project layout

- `src/` — extension source (TypeScript). Entry point: `src/extension.ts`.
- `src/engines/` — TTS engines (Edge neural, browser fallback).
- `src/player/` — the player webview controller (`playerPanel.ts`).
- `media/` — webview assets (`player.js`, `player.css`, icon). `media/flags/` is generated.
- `scripts/` — dev/build tooling. Not shipped. Notable: `copy-flags.mjs` (flag assets,
  runs on prepublish), `make-icon.js` (icon.png from icon.svg), `make-social.js`
  (social-preview.png), `generate-voices.js` (rebuilds `src/data/voices.json`).
- `src/data/voices.json` — curated voice table (regenerate with `scripts/generate-voices.js`).

## Pull requests

- Keep changes focused and run `npm run typecheck` before pushing.
- Describe the behavior change and how you tested it.

By contributing you agree your contributions are licensed under the project's
[MIT License](LICENSE).
