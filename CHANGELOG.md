# Changelog

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
