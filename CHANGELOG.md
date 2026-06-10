# Changelog

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
