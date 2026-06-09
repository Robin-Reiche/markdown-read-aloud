import * as vscode from 'vscode';
import * as path from 'path';
import type { Chunk, Gender, OutlineItem, ReadJob, TtsEngine } from '../types';
import { EdgeEngine } from '../engines/edgeEngine';
import { detectLocale } from '../languageDetector';
import { allCuratedLocales, curatedPair, displayName, getVoice, localeDisplay, pickVoice, voicesForLocale } from '../voices';

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
  private activeLocale = ''; // language the voice picker / gender toggle operate on
  private autoLang = true; // auto per-paragraph language switching (vs. one fixed voice)

  private generation = 0; // bumped on new job / voice change to discard stale synths
  private playingIndex = 0; // last sentence the webview reported playing (for warm pre-synth)
  private hadSuccess = false; // have we ever gotten audio from Edge this session?
  private supertonicWarned = false;

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
      vscode.l10n.t('Read Aloud'),
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
    this.engineId = this.resolveEngine(cfg);

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.iconPath = undefined;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
  }

  // ---- public API used by commands ----------------------------------------

  async startJob(job: ReadJob, startIndex: number) {
    this.job = job;
    this.docUri = vscode.Uri.parse(job.docUri);
    this.generation++;
    this.hadSuccess = false;
    this.cache.clear();
    this.inflight.clear();

    const cfg = vscode.workspace.getConfiguration('markdownReadAloud');
    const overrides = cfg.get<Record<string, string>>('voiceOverrides', {});
    this.gender = cfg.get<Gender>('preferredGender', 'female');
    this.engineId = this.resolveEngine(cfg); // re-resolve so a new read retries Edge after a fallback
    this.autoLang = cfg.get<boolean>('perParagraphLanguage', false);
    this.activeLocale = job.locale;
    this.currentVoice = pickVoice(job.locale, this.gender, overrides);
    const rate = cfg.get<number>('speed', 1);
    const volume = cfg.get<number>('volume', 1);

    this.panel.title = `▶ ${job.title}`;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.post({
      type: 'load',
      startIndex,
      engine: this.engineId,
      rate,
      volume,
      flagsBase: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'flags')).toString(),
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
        this.playingIndex = m.index;
        this.highlight(m.index);
        break;
      case 'ended':
        this.clearHighlight();
        this.panel.title = this.job ? this.job.title : vscode.l10n.t('Read Aloud');
        break;
      case 'setGender':
        this.changeGender(m.gender);
        break;
      case 'setVoice':
        this.changeVoice(m.shortName);
        break;
      case 'setLocale':
        this.changeLocale(m.locale);
        break;
      case 'detectLanguage':
        this.detectLanguage();
        break;
      case 'setAutoLang':
        this.setAutoLang(!!m.value);
        break;
      case 'persistSpeed':
        await vscode.workspace
          .getConfiguration('markdownReadAloud')
          .update('speed', m.value, vscode.ConfigurationTarget.Global);
        break;
      case 'persistVolume':
        await vscode.workspace
          .getConfiguration('markdownReadAloud')
          .update('volume', m.value, vscode.ConfigurationTarget.Global);
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

    const gen = this.generation;
    const chunk = this.job.chunks[index];
    let voice: string;
    let loc: string;
    if (this.autoLang) {
      loc = chunk.locale || this.job.locale;
      voice = pickVoice(loc, this.gender, this.overrides());
    } else {
      loc = this.activeLocale;
      voice = this.currentVoice;
    }
    const task = (async () => {
      try {
        const buf = await this.engine.synth(chunk.text, voice, loc);
        if (gen !== this.generation) return; // superseded by a voice change / new job
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        this.hadSuccess = true;
        this.cache.set(index, ab);
        this.sendAudio(index, ab);
      } catch (err: any) {
        if (gen !== this.generation) return; // stale error from a superseded synth — ignore
        if (this.engineId === 'edge' && !this.hadSuccess) {
          // Never reached the endpoint at all this session → likely offline.
          this.engineId = 'browser';
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Read Aloud: Edge voices unreachable ({0}). Falling back to system voices (offline).',
              String(err?.message || err)
            )
          );
          this.post({ type: 'engineFallback', engine: 'browser' });
        } else {
          // Transient failure mid-document → skip just this sentence.
          this.post({ type: 'audioError', index, message: String(err?.message || err) });
        }
      } finally {
        this.inflight.delete(index);
      }
    })();
    this.inflight.set(index, task);
    await task;
  }

  private resolveEngine(cfg: vscode.WorkspaceConfiguration): 'edge' | 'browser' {
    const choice = cfg.get<string>('engine', 'edge');
    if (choice === 'browser') return 'browser';
    if (choice === 'supertonic' && !this.supertonicWarned) {
      this.supertonicWarned = true;
      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Read Aloud: the offline Supertonic engine is coming in a later update — using Edge neural voices for now.'
        )
      );
    }
    return 'edge';
  }

  private sendAudio(index: number, ab: ArrayBuffer) {
    this.post({ type: 'audio', index, mime: this.engine.mime, bytes: ab });
  }

  private overrides(): Record<string, string> {
    return vscode.workspace.getConfiguration('markdownReadAloud').get<Record<string, string>>('voiceOverrides', {});
  }

  /** Drop cached audio, invalidate in-flight synths, refresh the UI; the next
   *  chunk requests pick up the new voice/language/gender state. */
  private invalidateAndRefresh() {
    this.generation++;
    this.cache.clear();
    this.inflight.clear();
    this.post({ type: 'voiceUi', ...this.voiceUiPayload() });
    // Warm the connection and pre-synthesize the current sentence (and the next)
    // for the new voice right now, in parallel with the webview round-trip, so
    // playback resumes with minimal delay instead of starting a cold synth only
    // after the webview asks for the chunk.
    if (this.engineId === 'edge' && this.job) {
      void this.provideChunk(this.playingIndex);
      void this.provideChunk(this.playingIndex + 1);
    }
  }

  /** Toggle automatic per-paragraph language switching vs. one fixed voice. */
  private setAutoLang(on: boolean) {
    this.autoLang = on;
    if (on && this.job) {
      this.activeLocale = this.job.locale;
      this.currentVoice = pickVoice(this.activeLocale, this.gender, this.overrides());
    }
    void vscode.workspace
      .getConfiguration('markdownReadAloud')
      .update('perParagraphLanguage', on, vscode.ConfigurationTarget.Global);
    this.invalidateAndRefresh();
  }

  /** Switch ♀/♂ — keeps the current mode; the gender applies to every paragraph. */
  private changeGender(gender: Gender) {
    this.gender = gender;
    if (!this.autoLang) this.currentVoice = pickVoice(this.activeLocale, gender, this.overrides());
    void vscode.workspace
      .getConfiguration('markdownReadAloud')
      .update('preferredGender', gender, vscode.ConfigurationTarget.Global);
    this.invalidateAndRefresh();
  }

  /** Manually choose a language (turns OFF auto per-paragraph). */
  private changeLocale(locale: string) {
    this.autoLang = false;
    this.activeLocale = locale;
    this.currentVoice = pickVoice(locale, this.gender, this.overrides());
    this.invalidateAndRefresh();
  }

  /** Manually choose a specific voice (turns OFF auto per-paragraph). */
  private changeVoice(shortName: string) {
    const v = getVoice(shortName);
    this.autoLang = false;
    this.gender = v && v.gender.toLowerCase() === 'male' ? 'male' : 'female';
    this.activeLocale = v ? v.locale : this.activeLocale;
    this.currentVoice = shortName;
    this.invalidateAndRefresh();
  }

  /** (Manual mode) detect the document's dominant language and switch to it. */
  private detectLanguage() {
    if (!this.job) return;
    const fallback = vscode.workspace.getConfiguration('markdownReadAloud').get<string>('fallbackLanguage', 'en-US');
    const text = this.job.chunks.map((c) => c.text).join(' ').slice(0, 3000);
    const det = detectLocale(text, fallback);
    this.changeLocale(det.locale);
    vscode.window.setStatusBarMessage(vscode.l10n.t('Read Aloud: detected {0}', localeDisplay(det.locale)), 3000);
  }

  /** Everything the webview needs to render the voice/language controls. */
  private voiceUiPayload() {
    const pair = curatedPair(this.activeLocale);
    return {
      autoLang: this.autoLang,
      locale: this.activeLocale,
      localeName: localeDisplay(this.activeLocale),
      languages: this.job ? this.job.languages.map((l) => ({ locale: l, name: localeDisplay(l) })) : [],
      voicePair: {
        female: pair.female ? { shortName: pair.female, name: displayName(pair.female) } : undefined,
        male: pair.male ? { shortName: pair.male, name: displayName(pair.male) } : undefined,
      },
      allVoices: voicesForLocale(this.activeLocale).map((v) => ({
        shortName: v.shortName,
        name: displayName(v.shortName),
        gender: v.gender.toLowerCase(),
        multilingual: v.multilingual,
      })),
      currentVoice: this.currentVoice,
      currentVoiceName: displayName(this.currentVoice),
      gender: this.gender,
    };
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
    return {
      title: job.title,
      chunks: job.chunks.map((c: Chunk) => ({ index: c.index, text: c.text, kind: c.kind })),
      outline: job.outline,
      locales: allCuratedLocales(),
      ...this.voiceUiPayload(),
    };
  }

  private post(message: any) {
    this.panel.webview.postMessage(message);
  }

  /** Localized UI strings injected into the webview, where vscode.l10n is unavailable.
   *  Calls must use the literal vscode.l10n.t() form so @vscode/l10n-dev can extract them. */
  private uiStrings(): Record<string, string> {
    return {
      title: vscode.l10n.t('Read Aloud'),
      play: vscode.l10n.t('Play'),
      pause: vscode.l10n.t('Pause'),
      stop: vscode.l10n.t('Stop'),
      prev: vscode.l10n.t('Previous sentence'),
      next: vscode.l10n.t('Next sentence'),
      seek: vscode.l10n.t('Seek'),
      slower: vscode.l10n.t('Slower'),
      faster: vscode.l10n.t('Faster'),
      speed: vscode.l10n.t('Speed'),
      mute: vscode.l10n.t('Mute'),
      unmute: vscode.l10n.t('Unmute'),
      volume: vscode.l10n.t('Volume'),
      female: vscode.l10n.t('Female'),
      male: vscode.l10n.t('Male'),
      voice: vscode.l10n.t('Voice'),
      language: vscode.l10n.t('Language'),
      sections: vscode.l10n.t('Sections'),
      autoLabel: vscode.l10n.t('Auto'),
      autoLangLabel: vscode.l10n.t('Auto language (per paragraph)'),
      languageAndVoices: vscode.l10n.t('Language & all voices'),
      detect: vscode.l10n.t('Detect'),
      detectTooltip: vscode.l10n.t("Detect the document's language and switch to it"),
      multilingual: vscode.l10n.t('multilingual'),
      sentencesOne: vscode.l10n.t('{0} sentence'),
      sentencesOther: vscode.l10n.t('{0} sentences'),
      estSeconds: vscode.l10n.t('~{0} s'),
      estMinutes: vscode.l10n.t('~{0} min'),
      autoPrefix: vscode.l10n.t('Auto: {0}'),
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const n = nonce();
    const L = this.uiStrings();
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const l10nBlob = JSON.stringify(L).replace(/</g, '\\u003c');
    const uiLang = vscode.env.language || 'en';
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
<html lang="${esc(uiLang)}">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${css}" rel="stylesheet" />
<title>${esc(L.title)}</title>
</head>
<body>
  <div id="app">
    <div id="head">
      <div id="title">${esc(L.title)}</div>
      <div id="lang"></div>
    </div>

    <section class="panel" id="panel-screen">
      <div id="transcript"><div id="lines"></div></div>
    </section>
    <div id="sr" class="sr-only" aria-live="polite"></div>

    <section class="panel" id="panel-transport">
      <div id="progress">
        <input id="scrub" type="range" min="0" max="1000" value="0" step="1" aria-label="${esc(L.seek)}" />
        <div id="times"><span id="time-cur">0:00</span><span id="time-total">0:00</span></div>
      </div>

      <div id="transport">
        <button id="prev" class="ghost" title="${esc(L.prev)}" aria-label="${esc(L.prev)}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5v14h2V5H6zm3 7l9 7V5l-9 7z"/></svg></button>
        <div class="key-well"><button id="play" class="key" aria-pressed="false" aria-label="${esc(L.play)}"><span class="glyph"><svg class="tri" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><svg class="bars" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg></span></button></div>
        <button id="stop" class="ghost" title="${esc(L.stop)}" aria-label="${esc(L.stop)}"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
        <button id="next" class="ghost" title="${esc(L.next)}" aria-label="${esc(L.next)}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5v14h2V5h-2zM15 12L6 5v14l9-7z"/></svg></button>
      </div>
    </section>

    <section class="panel" id="panel-settings">
      <div id="meta">
        <div id="gender-toggle" class="pill">
          <button data-gender="female" id="g-female">♀ <span id="g-female-name">${esc(L.female)}</span></button>
          <button data-gender="male" id="g-male">♂ <span id="g-male-name">${esc(L.male)}</span></button>
        </div>
      </div>

      <div id="speedwrap" class="sliderrow">
        <button id="speed-down" class="spd-btn" title="${esc(L.slower)}" aria-label="${esc(L.slower)}"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="11" width="14" height="2" rx="1"/></svg></button>
        <input id="speed" type="range" min="0.5" max="2.5" value="1" step="0.05" aria-label="${esc(L.speed)}" />
        <span id="speed-val">1.0×</span>
        <button id="speed-up" class="spd-btn" title="${esc(L.faster)}" aria-label="${esc(L.faster)}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg></button>
      </div>

      <div id="volrow" class="sliderrow">
        <button id="mute" class="vol-btn" title="${esc(L.mute)}" aria-label="${esc(L.mute)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path class="spk" d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" fill="currentColor" stroke="none"/><path class="wave wave1" d="M15.5 9.8a3.3 3.3 0 010 4.4"/><path class="wave wave2" d="M18 7.4a6.5 6.5 0 010 9.2"/><path class="slash" d="M3.5 3.5l17 17"/></svg></button>
        <input id="volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="${esc(L.volume)}" />
        <span id="vol-val">100%</span>
      </div>

      <details id="advanced">
        <summary>${esc(L.languageAndVoices)}</summary>
        <div class="advanced-body">
          <label class="check"><input type="checkbox" id="auto-lang" /> ${esc(L.autoLangLabel)}</label>
          <label class="adv-label" for="lang-button">${esc(L.language)}</label>
          <div class="lang-row">
            <div class="lang-combo" id="lang-combo">
              <button type="button" id="lang-button" class="lang-button" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(L.language)}"><span class="lang-flag" id="lang-button-flag"></span><span class="lang-label" id="lang-button-label">${esc(L.autoLabel)}</span><svg class="lang-caret" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg></button>
              <ul class="lang-list" id="lang-list" role="listbox" tabindex="-1" hidden></ul>
            </div>
            <button id="detect-lang" class="detect-btn" title="${esc(L.detectTooltip)}">⤿ ${esc(L.detect)}</button>
          </div>
          <label class="adv-label" for="voice-select">${esc(L.voice)}</label>
          <select id="voice-select"></select>
        </div>
      </details>
    </section>

    <section class="panel" id="outline-panel">
      <div id="outline"></div>
    </section>
  </div>
  <script nonce="${n}">window.__l10n=${l10nBlob};window.__uiLocale=${JSON.stringify(uiLang)};</script>
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
