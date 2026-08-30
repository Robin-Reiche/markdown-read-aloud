# Changelog

## 1.15.0 — 2026-08-30

Two settings for how the reader sits on your screen, both asked for in
[#2](https://github.com/Robin-Reiche/markdown-read-aloud/issues/2).

- **Choose where the reader opens.** The new `markdownReadAloud.openLocation` setting
  takes `beside` (the previous behavior, a split column next to your document) or
  `active`, which opens the reader as a tab in the current editor group without
  splitting anything. Useful on a single wide monitor, where a split just halves your
  reading width. The setting takes effect the next time the reader opens.
- **A fourth reading width.** The comfort row in the reader's settings popover now has
  **Full** next to Compact, Cozy and Wide. It drops the centered column limit and lets
  the text run the whole width of the panel, which helps with long CJK documents and
  wide tables. Like the other three it switches live and is remembered.

One thing to know about `active`: the reader tab covers your document, so the sentence
highlight in the editor has nothing visible to highlight. That is the trade for not
splitting the editor.

## 1.14.0 — 2026-08-24

**Supertonic offline voices are real.** Selecting the Supertonic engine now speaks
through a local [Supertonic](https://github.com/supertone-inc/supertonic) server
(`pip install 'supertonic[serve]'`, then `supertonic serve --host 127.0.0.1 --port 7788`)
instead of showing a "coming later" notice and silently using the online Edge engine.

- **Fail-closed privacy.** With Supertonic selected, document text only ever goes to
  the fixed loopback endpoint `127.0.0.1:7788`. If the server is unavailable, reading
  stops with setup instructions — switching to system voices or to Edge (online) is a
  separate, explicit choice.
- **Hardened local HTTP client.** Loopback-only endpoint, no redirects, connection and
  total timeouts, response size cap, and content-type + RIFF/WAVE validation. Errors
  never contain document text.
- New command **Read Aloud: Check Local Supertonic Server** verifies availability
  without sending any text.
- The `markdownReadAloud.engine` setting is now application-scoped, so a workspace's
  `.vscode/settings.json` can no longer flip a user from an offline engine to an
  online one. If you set the engine per workspace, that entry stops taking effect
  and the value from your user settings applies instead.
- The synthesized-audio cache is now LRU with both entry and byte budgets (WAV chunks
  are much larger than MP3), and the host enforces its own input-length limit on
  synthesis requests from the webview.
- The webview CSP nonce now comes from a cryptographically secure source.
- Unit tests (Node's built-in test runner) cover the new engine's request policy and
  the cache; `npm test`.

- **Wrapped paragraphs no longer shatter into fragments.** A paragraph that the
  Markdown source wraps across several lines was being split into one "sentence"
  per source line — the sentence splitter treats every line break as a sentence
  boundary (Unicode rule SB4). Each fragment was too short to language-detect
  reliably, so short bits like `Wegpunkten.` or `Waypoint-Limits.` were misread as
  Swedish/English and the voice flipped mid-paragraph. Line breaks are now folded
  to spaces before segmentation, so wrapped paragraphs read as whole sentences.
- **Auto-language off now holds offline too.** With Edge voices unreachable the
  reader falls back to system voices; that path picked a voice per segment from a
  rough heuristic, ignoring the "Auto language (per paragraph)" toggle. It now
  reads the whole document in the active language when the toggle is off.
- **Scroll freely while it reads.** Scrolling away (wheel, trackpad, or the scrollbar)
  now releases the auto-scroll so you can read ahead without the view snapping back to
  the spoken sentence on every new line. It re-follows only once you settle and the
  spoken sentence has come to rest near the center — or tap **Back to reading**.
- **"Read section" no longer covers the heading.** The hover button now floats in the
  whitespace above the heading instead of sitting on top of long, wrapped titles.
- **Readable code blocks & callouts in every theme.** Code blocks and blockquotes now
  derive their own background and text colors instead of inheriting VS Code's code
  colors, which on some light themes (e.g. Solarized) produced a dark box with
  dark, low-contrast text.

## 1.3.1 — 2026-06-10

- **Volume moved into the toolbar.** Mute + slider now live next to the speed chip;
  on narrow panels the slider yields first (mute stays), keeping the bar one calm line.
- Fix: toggling mute inside the settings popover closed the popover (the icon swap
  made the click look like an outside click).

## 1.3.0 — 2026-06-10

**A whole new reading experience.** The player is now a full reader: it renders the Markdown
as clean, beautiful prose (no more `#`/`*`/`[]()` noise) and reads it aloud with the spoken
sentence highlighted in place.

- **Rendered reader view.** Your document is shown as styled prose with sentence-synced
  highlighting, auto-scroll to the spoken line, and click-any-sentence-to-start-there.
- **Follows your VS Code theme** by default, with three hand-tuned reading themes to switch
  to: Study (dark), Daylight (light), and Paper (sepia).
- **Reading fonts.** Cycle through four bundled, multilingual reading faces — Literata,
  Inter, Atkinson Hyperlegible (built for maximum legibility), and IBM Plex Mono — with
  system/Noto fallback so every supported language renders.
- **Comfort presets** (Compact / Cozy / Wide) for measure, size, and line spacing.
- **Ambient focus** dims the surroundings and gently glows the sentence being read.
- **Collapsible sections** that re-open themselves the moment the voice reaches them, plus a
  per-section "Read section" button and reading-time estimates.
- Volume, speed, gender, auto per-paragraph language, and full voice/language pickers carry
  over, now in a tidy settings popover.

**A calmer, sturdier toolbar.** One quiet line — transport, title, a speed chip, settings —
that holds together at any panel width (down to very narrow side panels) and any height.
The settings popover anchors properly to the gear, closes on Escape, and returns focus.

**New in this release:**

- **Reading follows you, not the other way around.** Scroll anywhere while listening and the
  auto-scroll politely steps aside; a small "Back to reading" pill glides you back to the
  spoken sentence. Scrolling it back into view re-engages following automatically.
- **Picks up where you left off.** Each document remembers your last position; reopening it
  resumes there (with a quiet "Start over" escape hatch).
- **Seekable progress bar with chapter ticks.** The thin strip under the toolbar is now a
  podcast-style scrubber: headings appear as ticks, hover shows the section, click or drag
  to jump anywhere.
- **Status-bar mini-player.** Play/pause from VS Code's status bar while the reader tab is
  hidden — listening no longer needs the panel's pixels.
- **Sleep timer.** Stop after the current section, or after 15/30/60 minutes with a gentle
  fade-out.
- **Alt+Click → editor.** Hear a typo? Alt+Click the sentence and land on its source line.
- **Edit mode.** The pencil button opens the Markdown source beside the reader at the
  sentence you're on, and the reader re-renders live as you type — without losing your
  place or interrupting playback.
- **Pronunciation dictionary.** New `markdownReadAloud.pronunciations` setting — teach the
  voices your project's jargon ("nginx" → "engine x"), shareable via workspace settings.
- **Read from cursor works again**, and `codeBlocks` / `tables` / `announceHeadings` /
  `highlightWhileReading` / `engine` settings are honored by the new reader.
- **Keyboard end to end:** Space play/pause, ←/→ or ↑/↓ sentences, +/− speed, M mute,
  F font, Esc stop; sentences are focusable with visible focus rings, and the spoken
  sentence is announced to screen readers in its own language.
- Many playback fixes (stale audio on jumps, re-opening documents mid-playback, finished
  documents replaying only the last sentence), remote images in documents now load, and
  ~1 MB of unused assets removed from the package.

All new UI strings ship fully translated (DE, ES, FR, IT, JA, PT-BR, ZH-CN).

## 1.1.1 — 2026-06-09

- Fix the README Marketplace badges (version / installs / rating). shields.io retired its
  Visual Studio Marketplace badge service, so they showed "retired badge"; switched to
  vsmarketplacebadges.dev.

## 1.1.0 — 2026-06-09

- **Localized UI.** The player and all extension text now follow your VS Code display
  language, with full translations for German, Spanish, French, Italian, Japanese,
  Simplified Chinese and Brazilian Portuguese (anything untranslated falls back to English).
- Language names (e.g. "American English") now appear in your display language across the
  header, the language picker and the "detected" status message.

## 1.0.2 — 2026-06-09

- Added an animated demo (the player reading with live sentence highlighting) to the README and Marketplace listing.

## 1.0.1 — 2026-06-09

Marketplace listing polish — no functional changes.

- New README banner (social-preview card) and re-enabled Marketplace badges.
- Added GitHub Sponsors + Ko-fi support links.

## 1.0.0 — 2026-06-09

Initial release.

- Read Markdown aloud with free Microsoft Edge neural voices (cloud quality, no API key).
- Automatic language detection across 75 languages, mapped to a curated best female/male
  voice per language.
- Player panel (opens beside the editor, keeps playing in the background): play/pause,
  stop, previous/next sentence, 0.5×–2.5× speed, gender toggle, full voice picker,
  document outline for jumping.
- Read the whole document, from the cursor, or a selection.
- Sentence highlighting synced to playback in the editor.
- Robust Markdown handling (headings, lists, links, tables, code fences, frontmatter and
  special characters are turned into clean prose).
- Automatic fallback to system voices when the Edge endpoint is unreachable.
- One consistent voice per document by default; optional per-paragraph language
  switching (`perParagraphLanguage`) for mixed-language documents.
