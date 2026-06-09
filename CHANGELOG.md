# Changelog

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
