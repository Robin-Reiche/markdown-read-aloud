import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { Gender, TtsEngine } from '../types';
import { EdgeEngine } from '../engines/edgeEngine';
import { SupertonicHttpEngine, supertonicVoiceForGender } from '../engines/supertonicHttpEngine';
import { AudioCache } from './audioCache';
import { renderMarkdownHtml } from '../markdown/render';
import { normalizeForSpeech, applyPronunciations } from '../markdown/normalize';
import { detectLocale, detectReliableLocale } from '../languageDetector';
import {
  allCuratedLocales,
  curatedPair,
  displayName,
  getVoice,
  localeDisplay,
  pickVoice,
  voicesForLocale,
} from '../voices';

function nonce(): string {
  // CSP nonces must come from a cryptographically secure source
  return crypto.randomBytes(32).toString('base64url');
}

const FONT_FILES: Record<string, [string, number, 'normal' | 'italic']> = {
  'inter-latin-400-normal.woff2': ['Inter', 400, 'normal'],
  'inter-latin-500-normal.woff2': ['Inter', 500, 'normal'],
  'inter-latin-600-normal.woff2': ['Inter', 600, 'normal'],
  'inter-latin-700-normal.woff2': ['Inter', 700, 'normal'],
  'literata-latin-400-normal.woff2': ['Literata', 400, 'normal'],
  'literata-latin-400-italic.woff2': ['Literata', 400, 'italic'],
  'literata-latin-600-normal.woff2': ['Literata', 600, 'normal'],
  'literata-latin-700-normal.woff2': ['Literata', 700, 'normal'],
  'atkinson-hyperlegible-latin-400-normal.woff2': ['Atkinson Hyperlegible', 400, 'normal'],
  'atkinson-hyperlegible-latin-400-italic.woff2': ['Atkinson Hyperlegible', 400, 'italic'],
  'atkinson-hyperlegible-latin-700-normal.woff2': ['Atkinson Hyperlegible', 700, 'normal'],
  'ibm-plex-mono-latin-400-normal.woff2': ['IBM Plex Mono', 400, 'normal'],
  'ibm-plex-mono-latin-500-normal.woff2': ['IBM Plex Mono', 500, 'normal'],
};

const POSITIONS_KEY = 'markdownReadAloud.positions';
const PREFS_KEY = 'markdownReadAloud.readerPrefs';
const MAX_POSITIONS = 24;

type EngineId = 'edge' | 'supertonic' | 'browser';

/** Hard host-side cap on webview `synth` text — the webview is not a security boundary. */
const MAX_SYNTH_INPUT = 5000;
const MAX_CACHE_ENTRIES = 600;
const MAX_CACHE_BYTES = 128 * 1024 * 1024; // WAV chunks are big; bound bytes, not just entries

interface StoredPosition {
  idx: number;
  total: number;
  text: string;
  ts: number;
}

export interface OpenOptions {
  docUri?: vscode.Uri;
  /** character offset in `source` to start reading from (read-from-cursor) */
  startOffset?: number;
  isSelection?: boolean;
  /** 1-based line in the original document where `source` starts (selection reads) */
  baseLine?: number;
}

/**
 * The reader webview: renders the Markdown document as clean prose and reads it
 * aloud with sentence-synced highlighting. The webview owns segmentation and
 * playback; this host renders the HTML and answers per-sentence synthesis
 * requests with Edge neural voices (eld picks the language per sentence).
 *
 * Kept the class name + `current`/`control()` so the command layer is unchanged.
 */
export class PlayerPanel {
  static current: PlayerPanel | undefined;
  private static readonly viewType = 'markdownReadAloud.reader';
  private static status: vscode.StatusBarItem | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private disposed = false;

  private engine: TtsEngine | null = null; // created lazily so an unselected engine is never instantiated
  private engineId: EngineId = 'edge';
  private supertonicFailureNotified = false;

  private docLocale = 'en-US';
  private activeLocale = 'en-US'; // language the manual voice/locale picker operates on
  private currentVoice = '';
  private gender: Gender = 'female';
  private autoLang = true; // detect language per sentence (vs. one fixed voice)

  private docUri: vscode.Uri | undefined;
  private docTitle = '';
  private baseLine = 1;
  private isSelection = false;
  private lastLoad: any = null;
  private readyCount = 0;

  private generation = 0; // bumped on voice/lang/gender change to discard stale synths
  private hadSuccess = false; // have we ever gotten audio from Edge this session?

  private cache = new AudioCache(MAX_CACHE_ENTRIES, MAX_CACHE_BYTES); // key: engine|voice|locale|cleanText
  private inflight = new Map<string, Promise<void>>();

  static show(context: vscode.ExtensionContext): PlayerPanel {
    const column = vscode.ViewColumn.Beside;
    if (PlayerPanel.current) {
      PlayerPanel.current.panel.reveal(column, true);
      return PlayerPanel.current;
    }
    const roots = [vscode.Uri.joinPath(context.extensionUri, 'media')];
    for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri);
    const panel = vscode.window.createWebviewPanel(
      PlayerPanel.viewType,
      vscode.l10n.t('Read Aloud'),
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: roots,
      }
    );
    PlayerPanel.current = new PlayerPanel(panel, context);
    return PlayerPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.extensionUri = context.extensionUri;
    const cfg = vscode.workspace.getConfiguration('markdownReadAloud');
    this.gender = cfg.get<Gender>('preferredGender', 'female');
    this.autoLang = cfg.get<boolean>('perParagraphLanguage', false);
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    // live re-render while the source document is edited (like the built-in preview)
    vscode.workspace.onDidChangeTextDocument((e) => this.onDocChanged(e), null, this.disposables);
  }

  private updateTimer: NodeJS.Timeout | undefined;

  private onDocChanged(e: vscode.TextDocumentChangeEvent) {
    if (!this.docUri || this.isSelection || !this.lastLoad) return;
    if (e.document.uri.toString() !== this.docUri.toString()) return;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      if (this.disposed || !this.docUri) return;
      const html = renderMarkdownHtml(e.document.getText());
      this.lastLoad.html = html; // keep iframe-reload resends fresh
      this.post({ type: 'update', html });
    }, 400);
  }

  // ---- public API used by the commands ------------------------------------

  /** Render a document (or selection) into the reader and start it. */
  open(source: string, title: string, opts: OpenOptions = {}) {
    const cfg = vscode.workspace.getConfiguration('markdownReadAloud');
    const fallback = cfg.get<string>('fallbackLanguage', 'en-US');
    const autoDetect = cfg.get<boolean>('autoDetectLanguage', true);
    this.gender = cfg.get<Gender>('preferredGender', 'female');
    this.autoLang = cfg.get<boolean>('perParagraphLanguage', false);
    this.setEngine(this.resolveEngine(cfg));
    this.supertonicFailureNotified = false;
    if (this.engineId === 'supertonic') {
      // availability probe (no document text) so setup problems surface immediately
      void this.hostEngine()
        .warm('', '')
        .catch((err: any) => void this.notifySupertonicFailure(String(err?.message || err)));
    }
    this.docLocale = autoDetect ? detectLocale(source, fallback).locale : fallback;
    this.activeLocale = this.docLocale;
    this.currentVoice = pickVoice(this.docLocale, this.gender, this.overrides());
    this.generation++;
    this.hadSuccess = false;
    this.inflight.clear();

    this.docUri = opts.docUri;
    this.docTitle = title;
    this.baseLine = opts.baseLine ?? 1;
    this.isSelection = !!opts.isSelection;

    const docKey = opts.docUri && !opts.isSelection ? opts.docUri.toString() : '';
    const anchorText = typeof opts.startOffset === 'number' ? anchorFrom(source, opts.startOffset) : undefined;
    const resume = docKey && !anchorText ? this.positions()[docKey] : undefined;

    let baseHref = '';
    if (opts.docUri) {
      try {
        baseHref = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(opts.docUri, '..')).toString() + '/';
      } catch {
        /* untitled or virtual documents have no folder */
      }
    }

    const html = renderMarkdownHtml(source);
    this.panel.title = title;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.lastLoad = {
      type: 'load',
      html,
      title,
      docKey,
      baseHref,
      engine: this.engineId,
      rate: cfg.get<number>('speed', 1),
      volume: cfg.get<number>('volume', 1),
      settings: {
        codeBlocks: cfg.get<string>('codeBlocks', 'announce'),
        tables: cfg.get<string>('tables', 'skip'),
        announceHeadings: cfg.get<boolean>('announceHeadings', false),
        highlight: cfg.get<boolean>('highlightWhileReading', true),
      },
      prefs: this.context.globalState.get(PREFS_KEY) ?? null,
      resume: resume ? { idx: resume.idx, total: resume.total, text: resume.text } : null,
      anchorText: anchorText ?? null,
      autoplay: true,
      ...this.voiceUiPayload(),
    };
    this.post(this.lastLoad);
    this.updateStatus(false);
  }

  control(action: 'playpause' | 'stop') {
    this.post({ type: 'control', action });
  }

  // ---- message handling ----------------------------------------------------

  private async onMessage(m: any) {
    switch (m?.type) {
      case 'ready':
        // the first 'ready' is the initial page load (its 'load' message is buffered
        // by VS Code); later ones mean the webview iframe was reloaded — re-send.
        this.readyCount++;
        if (this.readyCount > 1 && this.lastLoad) this.post(this.lastLoad);
        break;
      case 'synth':
        await this.provideSynth(m.id, String(m.text || ''), Number(m.gen) || 0);
        break;
      case 'setGender':
        this.changeGender(m.gender === 'male' ? 'male' : 'female');
        break;
      case 'setAutoLang':
        this.setAutoLang(!!m.value);
        break;
      case 'setLocale':
        this.changeLocale(String(m.locale || this.activeLocale));
        break;
      case 'setVoice':
        this.changeVoice(String(m.shortName || ''));
        break;
      case 'position':
        this.savePosition(m);
        break;
      case 'playState':
        this.updateStatus(!!m.playing);
        break;
      case 'openSource':
      case 'editSource':
        await this.revealSource(Number(m.line) || 1);
        break;
      case 'persistPrefs':
        if (m.prefs && typeof m.prefs === 'object') {
          void this.context.globalState.update(PREFS_KEY, m.prefs);
        }
        break;
      case 'persistSpeed': {
        const n = Number(m.value);
        if (!Number.isFinite(n)) break;
        const v = Math.min(2.5, Math.max(0.5, n));
        await vscode.workspace.getConfiguration('markdownReadAloud').update('speed', v, vscode.ConfigurationTarget.Global);
        break;
      }
      case 'persistVolume': {
        const n = Number(m.value);
        if (!Number.isFinite(n)) break;
        const v = Math.min(1, Math.max(0, n));
        await vscode.workspace.getConfiguration('markdownReadAloud').update('volume', v, vscode.ConfigurationTarget.Global);
        break;
      }
    }
  }

  /** The configured engine is honored as-is — never silently substituted. */
  private resolveEngine(cfg: vscode.WorkspaceConfiguration): EngineId {
    const eng = cfg.get<string>('engine', 'edge');
    return eng === 'browser' || eng === 'supertonic' ? eng : 'edge';
  }

  /** Switch the host-side engine, disposing the old one. */
  private setEngine(id: EngineId) {
    if (id === this.engineId) return;
    this.engine?.dispose();
    this.engine = null;
    this.inflight.clear();
    this.engineId = id;
    this.supertonicFailureNotified = false;
  }

  private hostEngine(): TtsEngine {
    if (!this.engine) {
      this.engine = this.engineId === 'supertonic' ? new SupertonicHttpEngine() : new EdgeEngine();
    }
    return this.engine;
  }

  /**
   * Fail-closed handling for the offline engine: synthesis stops, nothing is
   * retried against an online service, and switching to Edge is a separate,
   * explicit user action that warns text will leave the machine.
   */
  private async notifySupertonicFailure(detail: string) {
    if (this.supertonicFailureNotified) return;
    this.supertonicFailureNotified = true;
    const retry = vscode.l10n.t('Retry');
    const useBrowser = vscode.l10n.t('Use System Voices (offline)');
    const useEdge = vscode.l10n.t('Use Edge Voices (online — sends text to Microsoft)');
    const choice = await vscode.window.showErrorMessage(
      vscode.l10n.t(
        'Read Aloud: the local Supertonic server is unavailable ({0}). No document text was sent anywhere. Start it with "supertonic serve --host 127.0.0.1 --port 7788", then retry.',
        detail
      ),
      retry,
      useBrowser,
      useEdge
    );
    if (this.disposed) return;
    if (choice === retry) {
      this.supertonicFailureNotified = false;
      this.post({ type: 'control', action: 'playpause' });
    } else if (choice === useBrowser) {
      this.switchEngineExplicit('browser');
    } else if (choice === useEdge) {
      this.switchEngineExplicit('edge');
    }
  }

  /** Explicit, user-chosen engine switch for this session (does not rewrite settings). */
  private switchEngineExplicit(id: EngineId) {
    this.setEngine(id);
    this.generation++;
    this.post({ type: 'engineChanged', engine: id });
  }

  // ---- per-document resume -------------------------------------------------

  private positions(): Record<string, StoredPosition> {
    return this.context.workspaceState.get<Record<string, StoredPosition>>(POSITIONS_KEY, {});
  }

  private savePosition(m: any) {
    const key = typeof m.docKey === 'string' ? m.docKey : '';
    if (!key) return;
    const all = { ...this.positions() };
    all[key] = { idx: Number(m.idx) || 0, total: Number(m.total) || 0, text: String(m.text || '').slice(0, 80), ts: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_POSITIONS) {
      keys.sort((a, b) => all[a].ts - all[b].ts);
      for (const k of keys.slice(0, keys.length - MAX_POSITIONS)) delete all[k];
    }
    void this.context.workspaceState.update(POSITIONS_KEY, all);
  }

  // ---- status bar mini-player ----------------------------------------------

  private updateStatus(playing: boolean) {
    if (!PlayerPanel.status) {
      PlayerPanel.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      PlayerPanel.status.command = 'markdownReadAloud.togglePlayPause';
      this.context.subscriptions.push(PlayerPanel.status);
    }
    const t = this.docTitle.length > 24 ? this.docTitle.slice(0, 23) + '…' : this.docTitle;
    PlayerPanel.status.text = `${playing ? '$(debug-pause)' : '$(play)'} ${t}`;
    PlayerPanel.status.tooltip = vscode.l10n.t('Read Aloud — click to play/pause');
    PlayerPanel.status.show();
    this.panel.title = playing ? `▶ ${this.docTitle}` : this.docTitle;
  }

  // ---- jump to source (Alt+Click) -------------------------------------------

  private async revealSource(line: number) {
    if (!this.docUri) return;
    try {
      const doc = await vscode.workspace.openTextDocument(this.docUri);
      const ln = Math.max(0, Math.min(doc.lineCount - 1, this.baseLine - 1 + line - 1));
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      const range = doc.lineAt(ln).range;
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch {
      /* document may be gone */
    }
  }

  // ---- synthesis -------------------------------------------------------------

  /** Synthesize one sentence on demand. The webview supplies the text, a stable id
   *  and its load generation (echoed back so late audio from a previous doc is dropped). */
  private async provideSynth(id: number, text: string, loadGen: number) {
    if (this.engineId === 'browser') return; // webview synthesizes locally
    if (text.length > MAX_SYNTH_INPUT) {
      // the webview targets ~sentence-sized chunks; anything this large is anomalous
      this.post({ type: 'audioError', id, gen: loadGen });
      return;
    }
    const cfg = vscode.workspace.getConfiguration('markdownReadAloud');
    const clean = applyPronunciations(
      normalizeForSpeech(text),
      cfg.get<Record<string, string>>('pronunciations', {})
    );
    if (!clean) {
      this.post({ type: 'audioError', id, gen: loadGen });
      return;
    }
    let locale: string;
    let voice: string;
    if (this.autoLang) {
      locale = detectReliableLocale(text) || this.docLocale;
      voice = pickVoice(locale, this.gender, this.overrides());
    } else {
      locale = this.activeLocale;
      voice = this.currentVoice;
    }
    // Supertonic voice styles (F1–F5/M1–M5) are a separate namespace — never
    // hand it an Edge voice short name.
    if (this.engineId === 'supertonic') voice = supertonicVoiceForGender(this.gender);
    const key = `${this.engineId}|${voice}|${locale}|${clean}`;

    const cached = this.cache.get(key);
    if (cached) {
      this.sendAudio(id, cached, loadGen, locale);
      return;
    }
    const gen = this.generation;
    if (this.inflight.has(key)) {
      this.inflight.get(key)!.then(() => {
        if (gen !== this.generation) return;
        const ab = this.cache.get(key);
        if (ab) this.sendAudio(id, ab, loadGen, locale);
        else this.post({ type: 'audioError', id, gen: loadGen });
      });
      return;
    }
    const task = (async () => {
      try {
        const buf = await this.hostEngine().synth(clean, voice, locale);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        this.hadSuccess = true;
        this.cache.set(key, ab); // LRU, capped by entries and total bytes
        if (gen === this.generation) this.sendAudio(id, ab, loadGen, locale);
      } catch (err: any) {
        if (gen !== this.generation) return;
        if (this.engineId === 'supertonic') {
          // Fail closed: stop playback, report, and never substitute an online engine.
          this.post({ type: 'control', action: 'stop' });
          this.post({ type: 'audioError', id, gen: loadGen });
          void this.notifySupertonicFailure(String(err?.message || err));
        } else if (this.engineId === 'edge' && !this.hadSuccess) {
          this.setEngine('browser');
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Read Aloud: Edge voices unreachable ({0}). Falling back to system voices (offline).',
              String(err?.message || err)
            )
          );
          this.post({ type: 'engineFallback', engine: 'browser' });
        } else {
          this.post({ type: 'audioError', id, gen: loadGen, message: String(err?.message || err) });
        }
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    await task;
  }

  private sendAudio(id: number, ab: ArrayBuffer, gen: number, locale: string) {
    this.post({ type: 'audio', id, gen, locale, mime: this.hostEngine().mime, bytes: ab });
  }

  private overrides(): Record<string, string> {
    return vscode.workspace.getConfiguration('markdownReadAloud').get<Record<string, string>>('voiceOverrides', {});
  }

  private invalidateAndRefresh() {
    this.generation++;
    this.post({ type: 'voiceUi', ...this.voiceUiPayload() });
  }

  private setAutoLang(on: boolean) {
    this.autoLang = on;
    if (on) {
      this.activeLocale = this.docLocale;
      this.currentVoice = pickVoice(this.activeLocale, this.gender, this.overrides());
    }
    void vscode.workspace
      .getConfiguration('markdownReadAloud')
      .update('perParagraphLanguage', on, vscode.ConfigurationTarget.Global);
    this.invalidateAndRefresh();
  }

  private changeGender(gender: Gender) {
    this.gender = gender;
    if (!this.autoLang) this.currentVoice = pickVoice(this.activeLocale, gender, this.overrides());
    void vscode.workspace
      .getConfiguration('markdownReadAloud')
      .update('preferredGender', gender, vscode.ConfigurationTarget.Global);
    this.invalidateAndRefresh();
  }

  private changeLocale(locale: string) {
    this.autoLang = false;
    this.activeLocale = locale;
    this.currentVoice = pickVoice(locale, this.gender, this.overrides());
    this.invalidateAndRefresh();
  }

  private changeVoice(shortName: string) {
    const v = getVoice(shortName);
    this.autoLang = false;
    if (v) {
      this.gender = v.gender.toLowerCase() === 'male' ? 'male' : 'female';
      this.activeLocale = v.locale;
    }
    this.currentVoice = shortName;
    this.invalidateAndRefresh();
  }

  /** Everything the webview needs to render the voice/language controls. */
  private voiceUiPayload() {
    const pair = curatedPair(this.activeLocale);
    return {
      autoLang: this.autoLang,
      locale: this.activeLocale,
      localeName: localeDisplay(this.activeLocale),
      locales: allCuratedLocales(),
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

  private post(message: any) {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message);
  }

  /** Localized UI strings injected into the webview (vscode.l10n is host-only).
   *  Calls must use the literal vscode.l10n.t() form so @vscode/l10n-dev can extract them. */
  private uiStrings(): Record<string, string> {
    return {
      title: vscode.l10n.t('Read Aloud'),
      play: vscode.l10n.t('Play'),
      pause: vscode.l10n.t('Pause'),
      stop: vscode.l10n.t('Stop'),
      prev: vscode.l10n.t('Previous sentence'),
      next: vscode.l10n.t('Next sentence'),
      speed: vscode.l10n.t('Speed'),
      volume: vscode.l10n.t('Volume'),
      mute: vscode.l10n.t('Mute'),
      unmute: vscode.l10n.t('Unmute'),
      female: vscode.l10n.t('Female'),
      male: vscode.l10n.t('Male'),
      voice: vscode.l10n.t('Voice'),
      language: vscode.l10n.t('Language'),
      autoLangLabel: vscode.l10n.t('Auto language (per paragraph)'),
      multilingual: vscode.l10n.t('multilingual'),
      readingFont: vscode.l10n.t('Reading font'),
      comfort: vscode.l10n.t('Comfort'),
      compact: vscode.l10n.t('Compact'),
      cozy: vscode.l10n.t('Cozy'),
      wide: vscode.l10n.t('Wide'),
      theme: vscode.l10n.t('Theme'),
      themeAuto: vscode.l10n.t('Follow VS Code'),
      themeStudy: vscode.l10n.t('Study'),
      themeDaylight: vscode.l10n.t('Daylight'),
      themePaper: vscode.l10n.t('Paper'),
      ambient: vscode.l10n.t('Ambient focus'),
      badges: vscode.l10n.t('Show language badges'),
      readSection: vscode.l10n.t('Read section'),
      settings: vscode.l10n.t('More settings'),
      reading: vscode.l10n.t('Reading'),
      playback: vscode.l10n.t('Playback'),
      minShort: vscode.l10n.t('~{0} min'),
      edit: vscode.l10n.t('Edit source'),
      collapseAll: vscode.l10n.t('Collapse all sections'),
      expandAll: vscode.l10n.t('Expand all sections'),
      toggleSection: vscode.l10n.t('Toggle section'),
      backToReading: vscode.l10n.t('Back to reading'),
      startOver: vscode.l10n.t('Start over'),
      resumed: vscode.l10n.t('Resumed where you left off'),
      sleepTimer: vscode.l10n.t('Sleep timer'),
      off: vscode.l10n.t('Off'),
      untilSectionEnd: vscode.l10n.t('Until end of section'),
      codeBlock: vscode.l10n.t('Code block'),
      heading: vscode.l10n.t('Heading'),
      sentenceOf: vscode.l10n.t('Sentence {0} of {1}'),
      progress: vscode.l10n.t('Progress'),
      nothingToRead: vscode.l10n.t('Nothing readable in this document.'),
      openInEditor: vscode.l10n.t('Alt+Click a sentence to open it in the editor'),
      fontSerifSub: vscode.l10n.t('warm serif'),
      fontSansSub: vscode.l10n.t('clean sans'),
      fontA11ySub: vscode.l10n.t('max legibility'),
      fontMonoSub: vscode.l10n.t('calm, technical'),
    };
  }

  private fontFaceCss(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.extensionUri, 'media', 'fonts');
    return Object.entries(FONT_FILES)
      .map(([file, [family, weight, style]]) => {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(base, file));
        return `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:swap;src:url(${uri}) format('woff2');}`;
      })
      .join('\n');
  }

  private getHtml(webview: vscode.Webview): string {
    const n = nonce();
    const L = this.uiStrings();
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const l10nBlob = JSON.stringify(L).replace(/</g, '\\u003c');
    const uiLang = vscode.env.language || 'en';
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'reader.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'reader.css'));
    const csp = [
      `default-src 'none'`,
      `media-src blob: data:`,
      `img-src ${webview.cspSource} https: blob: data:`,
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
<style>${this.fontFaceCss(webview)}</style>
<link href="${css}" rel="stylesheet" />
<title>${esc(L.title)}</title>
</head>
<body class="hide-badges">
  <div id="app"></div>
  <div id="sr" class="sr-only" role="status" aria-live="polite"></div>
  <script nonce="${n}">window.__l10n=${l10nBlob};window.__uiLocale=${JSON.stringify(uiLang)};</script>
  <script nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.updateTimer) clearTimeout(this.updateTimer);
    PlayerPanel.current = undefined;
    PlayerPanel.status?.hide();
    this.engine?.dispose();
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

/** Plain-text anchor for "read from cursor": the first prose-looking line at/after the offset. */
function anchorFrom(source: string, offset: number): string | undefined {
  const rest = source.slice(Math.max(0, Math.min(source.length, offset)));
  for (const raw of rest.split('\n').slice(0, 40)) {
    const plain = raw
      .replace(/`{3,}.*/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#>*_`~|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = plain.match(/[\p{L}\p{N}']+/gu) || [];
    if (words.length >= 3) return plain.slice(0, 80);
  }
  return undefined;
}
