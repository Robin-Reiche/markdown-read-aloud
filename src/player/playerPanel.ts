import * as vscode from 'vscode';
import * as path from 'path';
import type { Chunk, Gender, OutlineItem, ReadJob, TtsEngine } from '../types';
import { EdgeEngine } from '../engines/edgeEngine';
import { curatedPair, displayName, localeDisplay, pickVoice, voicesForLocale } from '../voices';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class PlayerPanel {
  static current: PlayerPanel | undefined;
  private static readonly viewType = 'markdownReadAloud.player';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private engine: TtsEngine = new EdgeEngine();
  private engineId: 'edge' | 'browser' = 'edge';
  private job?: ReadJob;
  private docUri?: vscode.Uri;
  private currentVoice = '';
  private gender: Gender = 'female';

  private cache = new Map<number, ArrayBuffer>();
  private inflight = new Map<number, Promise<void>>();

  private decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderRadius: '2px',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  static show(extensionUri: vscode.Uri): PlayerPanel {
    const column = vscode.ViewColumn.Beside;
    if (PlayerPanel.current) {
      PlayerPanel.current.panel.reveal(column, true);
      return PlayerPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      PlayerPanel.viewType,
      'Read Aloud',
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    PlayerPanel.current = new PlayerPanel(panel, extensionUri);
    return PlayerPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    const cfg = vscode.workspace.getConfiguration('markdownReadAloud');
    this.gender = cfg.get<Gender>('preferredGender', 'female');
    this.engineId = cfg.get<string>('engine', 'edge') === 'browser' ? 'browser' : 'edge';

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.iconPath = undefined;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
  }

  // ---- public API used by commands ----------------------------------------

  async startJob(job: ReadJob, startIndex: number) {
    this.job = job;
    this.docUri = vscode.Uri.parse(job.docUri);
    this.cache.clear();
    this.inflight.clear();

    const cfg = vscode.workspace.getConfiguration('markdownReadAloud');
    const overrides = cfg.get<Record<string, string>>('voiceOverrides', {});
    this.gender = cfg.get<Gender>('preferredGender', 'female');
    this.currentVoice = pickVoice(job.locale, this.gender, overrides);
    const rate = cfg.get<number>('speed', 1);

    this.panel.title = `▶ ${job.title}`;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.post({
      type: 'load',
      autostart: true,
      startIndex,
      engine: this.engineId,
      rate,
      job: this.serializeJob(job),
    });
  }

  control(action: 'playpause' | 'stop') {
    this.post({ type: 'control', action });
    if (action === 'stop') this.clearHighlight();
  }

  // ---- message handling ----------------------------------------------------

  private async onMessage(m: any) {
    switch (m?.type) {
      case 'ready':
        // webview reloaded (e.g. after being hidden) — nothing to push proactively
        break;
      case 'needChunk':
        await this.provideChunk(m.index);
        break;
      case 'nowPlaying':
        this.highlight(m.index);
        break;
      case 'ended':
        this.clearHighlight();
        this.panel.title = this.job ? this.job.title : 'Read Aloud';
        break;
      case 'setGender':
        await this.changeGender(m.gender);
        break;
      case 'setVoice':
        await this.changeVoice(m.shortName, m.gender);
        break;
      case 'persistSpeed':
        await vscode.workspace
          .getConfiguration('markdownReadAloud')
          .update('speed', m.value, vscode.ConfigurationTarget.Global);
        break;
    }
  }

  private async provideChunk(index: number) {
    if (!this.job || index < 0 || index >= this.job.chunks.length) return;
    if (this.engineId === 'browser') return; // webview synthesizes locally

    if (this.cache.has(index)) {
      this.sendAudio(index, this.cache.get(index)!);
      return;
    }
    if (this.inflight.has(index)) return;

    const task = (async () => {
      try {
        await this.engine.setVoice(this.currentVoice);
        const buf = await this.engine.synth(this.job!.chunks[index].text);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        this.cache.set(index, ab);
        this.sendAudio(index, ab);
      } catch (err: any) {
        // First failure: fall back to the browser speech engine for the whole session.
        if (this.engineId === 'edge') {
          this.engineId = 'browser';
          vscode.window.showWarningMessage(
            `Edge-Stimmen nicht erreichbar (${err?.message || err}). Wechsle auf System-Stimmen (offline).`
          );
          this.post({ type: 'engineFallback', engine: 'browser' });
        } else {
          this.post({ type: 'audioError', index, message: String(err?.message || err) });
        }
      } finally {
        this.inflight.delete(index);
      }
    })();
    this.inflight.set(index, task);
    await task;
  }

  private sendAudio(index: number, ab: ArrayBuffer) {
    this.post({ type: 'audio', index, mime: this.engine.mime, bytes: ab });
  }

  private async changeGender(gender: Gender) {
    this.gender = gender;
    if (!this.job) return;
    const overrides = vscode.workspace.getConfiguration('markdownReadAloud').get<Record<string, string>>('voiceOverrides', {});
    const voice = pickVoice(this.job.locale, gender, overrides);
    await this.applyVoice(voice, gender);
  }

  private async changeVoice(shortName: string, gender?: Gender) {
    await this.applyVoice(shortName, gender ?? this.gender);
  }

  private async applyVoice(voice: string, gender: Gender) {
    this.currentVoice = voice;
    this.gender = gender;
    this.cache.clear();
    this.inflight.clear();
    this.post({ type: 'voiceChanged', currentVoice: voice, gender, name: displayName(voice) });
  }

  // ---- highlighting --------------------------------------------------------

  private highlight(index: number) {
    if (!this.job || !this.docUri) return;
    if (!vscode.workspace.getConfiguration('markdownReadAloud').get('highlightWhileReading', true)) return;
    const chunk = this.job.chunks[index];
    if (!chunk) return;
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === this.docUri!.toString()
    );
    if (!editor) return;
    const start = editor.document.positionAt(chunk.blockStartOffset);
    const end = editor.document.positionAt(chunk.blockEndOffset);
    const range = new vscode.Range(start, end);
    editor.setDecorations(this.decoration, [range]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private clearHighlight() {
    if (!this.docUri) return;
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === this.docUri!.toString()
    );
    editor?.setDecorations(this.decoration, []);
  }

  // ---- serialization for the webview --------------------------------------

  private serializeJob(job: ReadJob) {
    const pair = curatedPair(job.locale);
    const all = voicesForLocale(job.locale).map((v) => ({
      shortName: v.shortName,
      name: displayName(v.shortName),
      gender: v.gender.toLowerCase(),
      multilingual: v.multilingual,
    }));
    return {
      title: job.title,
      locale: job.locale,
      localeName: localeDisplay(job.locale),
      chunks: job.chunks.map((c: Chunk) => ({ index: c.index, text: c.text, kind: c.kind })),
      outline: job.outline,
      voicePair: {
        female: pair.female ? { shortName: pair.female, name: displayName(pair.female) } : undefined,
        male: pair.male ? { shortName: pair.male, name: displayName(pair.male) } : undefined,
      },
      allVoices: all,
      currentVoice: this.currentVoice,
      currentVoiceName: displayName(this.currentVoice),
      gender: this.gender,
    };
  }

  private post(message: any) {
    this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const n = nonce();
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'player.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'player.css'));
    const csp = [
      `default-src 'none'`,
      `media-src blob: data:`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${n}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${css}" rel="stylesheet" />
<title>Read Aloud</title>
</head>
<body>
  <div id="app">
    <div id="header">
      <div id="title">Read Aloud</div>
      <div id="lang"></div>
    </div>

    <div id="transcript" aria-live="polite"></div>

    <div id="scrubrow">
      <span id="time-cur">0:00</span>
      <input id="scrub" type="range" min="0" max="1000" value="0" step="1" />
      <span id="time-total">0:00</span>
    </div>

    <div id="controls">
      <button id="prev" title="Previous sentence">⏮</button>
      <button id="play" class="primary" title="Play / Pause">▶</button>
      <button id="stop" title="Stop">⏹</button>
      <button id="next" title="Next sentence">⏭</button>
    </div>

    <div id="row-speed">
      <label>Speed <span id="speed-val">1.0×</span></label>
      <input id="speed" type="range" min="0.5" max="2.5" value="1" step="0.05" />
    </div>

    <div id="row-voice">
      <div id="gender-toggle">
        <button data-gender="female" id="g-female">♀ <span id="g-female-name">Female</span></button>
        <button data-gender="male" id="g-male">♂ <span id="g-male-name">Male</span></button>
      </div>
      <details id="advanced">
        <summary>All voices for this language</summary>
        <select id="voice-select"></select>
      </details>
    </div>

    <div id="outline"></div>

    <div id="gesture-overlay" class="hidden">
      <button id="gesture-play">▶ Click to start reading</button>
    </div>
  </div>
  <script nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }

  dispose() {
    PlayerPanel.current = undefined;
    this.clearHighlight();
    this.decoration.dispose();
    this.engine.dispose();
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
