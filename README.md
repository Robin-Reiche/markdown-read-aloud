# Markdown Read Aloud

Listen to your Markdown instead of reading it. **Markdown Read Aloud** turns any
`.md` file into clean, natural speech using high-quality **neural voices — for free,
no API key, no sign-up.** Built for the age of AI-generated docs, when you have more
Markdown to get through than time to read it.

![Read Aloud player](media/icon.png)

## Why it's nice

- **🎧 Cloud-quality voices, free.** Uses Microsoft Edge's neural voices (the same
  models behind Azure's "natural" voices) — genuinely expressive, not robotic.
- **🌍 Automatic language detection.** Reads German with a German voice, English with
  an English voice, and so on across **75 languages** — detected from the file itself.
- **♀ ♂ Curated voices, not a wall of options.** One great female and one great male
  voice per language by default. Power users can still pick any voice.
- **⏩ Speed & start point you control.** 0.5×–2.5× live, start from the cursor, a
  selection, or jump to any heading.
- **🧹 Handles messy Markdown.** Strips headings, lists, links, tables, code fences and
  special characters so the voice reads prose, not syntax.
- **🖍️ Follow along.** The sentence being read is highlighted and scrolled to in the editor.
- **🎚️ Keeps playing in the background** while you work in other files.

## How to use

1. Open a Markdown file.
2. Run a command (Command Palette, or the **🔊 speaker icon** in the editor title bar):
   - **Read Aloud: Read Whole Document**
   - **Read Aloud: Read from Cursor** — `Ctrl+Alt+R` (`Cmd+Alt+R` on macOS)
   - **Read Aloud: Read Selection** (right-click a selection)
3. A player opens beside your editor. Hit ▶, pick ♀/♂, set the speed, jump around the outline.
   - Play/Pause from anywhere: `Ctrl+Alt+Space`.

## Engines

| Engine | Quality | Network | Notes |
|---|---|---|---|
| **Edge** (default) | ★★★ neural | online | Free, no key. Recommended. |
| **Supertonic** | ★★★ neural | offline | Fully on-device (downloads models on first use). *Coming in a later update.* |
| **Browser** | ★ system | offline | Your OS voices. Automatic fallback if Edge is unreachable. |

Switch via the `markdownReadAloud.engine` setting.

## Settings

| Setting | Default | Description |
|---|---|---|
| `markdownReadAloud.engine` | `edge` | TTS engine to use. |
| `markdownReadAloud.preferredGender` | `female` | Default voice gender. |
| `markdownReadAloud.speed` | `1.0` | Default playback speed (0.5–2.5). |
| `markdownReadAloud.autoDetectLanguage` | `true` | Detect language and pick a matching voice. |
| `markdownReadAloud.fallbackLanguage` | `en-US` | Used when detection is unreliable. |
| `markdownReadAloud.voiceOverrides` | `{}` | Per-language voice override, e.g. `{ "de-DE": "de-DE-KatjaNeural" }`. |
| `markdownReadAloud.announceHeadings` | `false` | Say "Heading" before headings. |
| `markdownReadAloud.codeBlocks` | `announce` | `skip` / `announce` / `read` code blocks. |
| `markdownReadAloud.tables` | `skip` | `skip` / `read` tables. |
| `markdownReadAloud.highlightWhileReading` | `true` | Highlight the current sentence in the editor. |

## Privacy & note on the Edge engine

The Edge engine sends the text to be spoken to Microsoft's public Edge "Read Aloud"
endpoint to synthesize audio. No account or key is required and nothing else is
collected by this extension. This endpoint is the same one Microsoft Edge uses; it is
unofficial for third-party use and could change. If it becomes unavailable, the
extension automatically falls back to your system voices. For a fully offline,
no-network experience, an on-device engine (Supertonic) is planned.

## License

MIT © Robin Reiche. See [LICENSE](LICENSE).
