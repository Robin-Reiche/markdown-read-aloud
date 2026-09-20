import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EdgeEngine } from '../engines/edgeEngine';
import {
  SupertonicHttpEngine,
  SUPERTONIC_MAX_INPUT_LENGTH,
  supertonicVoiceForGender,
} from '../engines/supertonicHttpEngine';
import { buildJob } from '../reader';
import { applyPronunciations, normalizeForSpeech } from '../markdown/normalize';
import { pickVoice } from '../voices';
import { joinWav, withId3 } from './audioContainer';
import type { Chunk, Gender, TtsEngine } from '../types';

type ExportEngineId = 'edge' | 'supertonic';

const MAX_CONCURRENCY = 8;

/**
 * Render the whole document to a single audio file on disk, so it can be moved to
 * a phone and listened to offline.
 *
 * Synthesis is the same path the reader uses (same blocks, same sentence split,
 * same voice selection), just driven from the host instead of the webview and
 * written to a file rather than streamed. Each engine keeps one serial socket, so
 * a small pool of engines is what actually makes a long document finish quickly.
 */
export async function exportDocumentAudio(uriArg?: vscode.Uri) {
  const doc = await resolveDocument(uriArg);
  if (!doc) return;

  const source = doc.getText();
  if (!source.trim()) {
    vscode.window.showInformationMessage(vscode.l10n.t('Read Aloud: nothing readable found in this document.'));
    return;
  }

  const cfg = vscode.workspace.getConfiguration('markdownReadAloud');
  const engineId = await resolveExportEngine(cfg.get<string>('engine', 'edge'));
  if (!engineId) return;

  const job = buildJob({ source, baseOffset: 0, docUri: doc.uri, title: baseName(doc.uri) });
  if (!job || !job.chunks.length) {
    vscode.window.showInformationMessage(vscode.l10n.t('Read Aloud: nothing readable found in this document.'));
    return;
  }

  const target = await resolveTarget(doc.uri, engineId === 'edge' ? '.mp3' : '.wav', cfg);
  if (!target) return;

  const parts = await synthesizeAll(job.chunks, engineId, cfg, job.locale);
  if (!parts) return; // cancelled

  const buffers = parts.buffers.filter((b): b is Buffer => !!b && b.length > 0);
  if (!buffers.length) {
    vscode.window.showErrorMessage(vscode.l10n.t('Read Aloud: export failed — no audio was produced.'));
    return;
  }

  let out: Buffer;
  try {
    out =
      engineId === 'edge'
        ? withId3(Buffer.concat(buffers), {
            title: path.basename(target.fsPath, path.extname(target.fsPath)),
            artist: 'Markdown Read Aloud',
          })
        : joinWav(buffers);
  } catch (err: any) {
    vscode.window.showErrorMessage(
      vscode.l10n.t('Read Aloud: could not assemble the audio file ({0}).', String(err?.message || err))
    );
    return;
  }

  try {
    await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
    await fs.writeFile(target.fsPath, out);
  } catch (err: any) {
    vscode.window.showErrorMessage(
      vscode.l10n.t('Read Aloud: could not write {0} ({1}).', displayPath(target.fsPath), String(err?.message || err))
    );
    return;
  }

  const skipped = parts.failed;
  const size = `${(out.length / (1024 * 1024)).toFixed(1)} MB`;
  const message =
    skipped > 0
      ? vscode.l10n.t(
          'Read Aloud: saved {0} ({1}) — {2} sentence(s) could not be synthesized.',
          displayPath(target.fsPath),
          size,
          String(skipped)
        )
      : vscode.l10n.t('Read Aloud: saved {0} ({1}).', displayPath(target.fsPath), size);
  const reveal = vscode.l10n.t('Show in Folder');
  const choice = await vscode.window.showInformationMessage(message, reveal);
  if (choice === reveal) void vscode.commands.executeCommand('revealFileInOS', target);
}

// ---- inputs ---------------------------------------------------------------

async function resolveDocument(uriArg?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (uriArg) {
    try {
      return await vscode.workspace.openTextDocument(uriArg);
    } catch {
      /* fall through to the active editor */
    }
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) return editor.document;
  vscode.window.showErrorMessage(vscode.l10n.t('Read Aloud: open a Markdown file first.'));
  return undefined;
}

/**
 * The browser engine synthesizes inside the webview and hands the host no bytes,
 * so it cannot produce a file. Offer Edge explicitly rather than silently going
 * online with the document text.
 */
async function resolveExportEngine(configured: string): Promise<ExportEngineId | undefined> {
  if (configured === 'supertonic') return 'supertonic';
  if (configured !== 'browser') return 'edge';

  const useEdge = vscode.l10n.t('Use Edge Voices (online — sends text to Microsoft)');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Read Aloud: system voices cannot be exported to a file. Export with Edge neural voices instead, or set "markdownReadAloud.engine" to "supertonic" to keep synthesis on this machine.'
    ),
    { modal: true },
    useEdge
  );
  return choice === useEdge ? 'edge' : undefined;
}

function baseName(uri: vscode.Uri): string {
  return path.basename(uri.fsPath) || vscode.l10n.t('Document');
}

/** The folder exports go to: `markdownReadAloud.exportFolder`, or ~/Downloads when unset. */
function defaultFolder(cfg: vscode.WorkspaceConfiguration): string {
  const configured = (cfg.get<string>('exportFolder', '') || '').trim();
  return configured
    ? path.resolve(configured.replace(/^~(?=$|[/\\])/, os.homedir()))
    : path.join(os.homedir(), 'Downloads');
}

/** Render an absolute path with the home directory shortened back to `~`. */
function displayPath(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

/**
 * Pick where the file goes. The default destination is shown up front so it is never
 * a surprise, with an escape hatch for this one export and one for changing the
 * default permanently.
 */
async function resolveTarget(
  docUri: vscode.Uri,
  ext: string,
  cfg: vscode.WorkspaceConfiguration
): Promise<vscode.Uri | undefined> {
  const stem = sanitize(path.basename(docUri.fsPath, path.extname(docUri.fsPath)) || 'document');
  let folder = defaultFolder(cfg);

  type Choice = 'save' | 'saveAs' | 'changeDefault';
  const items: (vscode.QuickPickItem & { id: Choice })[] = [
    {
      id: 'save',
      label: vscode.l10n.t('$(cloud-download) Save {0}', stem + ext),
      detail: displayPath(path.join(folder, stem + ext)),
    },
    {
      id: 'saveAs',
      label: vscode.l10n.t('$(save-as) Save As…'),
      detail: vscode.l10n.t('Choose a location for this export only'),
    },
    {
      id: 'changeDefault',
      label: vscode.l10n.t('$(folder-opened) Change default folder…'),
      detail: vscode.l10n.t('Save here and use this folder for future exports'),
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Export "{0}" as audio', baseName(docUri)),
    placeHolder: vscode.l10n.t('Where should the audio file be saved?'),
  });
  if (!picked) return undefined;

  if (picked.id === 'saveAs') {
    const chosen = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(folder, stem + ext)),
      filters: { [ext === '.mp3' ? 'MP3 audio' : 'WAV audio']: [ext.slice(1)] },
      saveLabel: vscode.l10n.t('Export'),
    });
    return chosen; // the native dialog already confirmed any overwrite
  }

  if (picked.id === 'changeDefault') {
    const chosen = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(folder),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: vscode.l10n.t('Use This Folder'),
    });
    if (!chosen?.length) return undefined;
    folder = chosen[0].fsPath;
    await cfg.update('exportFolder', folder, vscode.ConfigurationTarget.Global);
  }

  let file = path.join(folder, stem + ext);
  if (!(await exists(file))) return vscode.Uri.file(file);

  const overwrite = vscode.l10n.t('Overwrite');
  const keepBoth = vscode.l10n.t('Keep Both');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Read Aloud: {0} already exists.', displayPath(file)),
    overwrite,
    keepBoth
  );
  if (choice === overwrite) return vscode.Uri.file(file);
  if (choice !== keepBoth) return undefined;

  for (let i = 2; i < 1000; i++) {
    file = path.join(folder, `${stem}-${i}${ext}`);
    if (!(await exists(file))) return vscode.Uri.file(file);
  }
  return undefined;
}

function sanitize(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/\.+$/, '') || 'document';
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// ---- synthesis -------------------------------------------------------------

/** Synthesize every chunk, in order, across a small pool of engines. */
async function synthesizeAll(
  chunks: Chunk[],
  engineId: ExportEngineId,
  cfg: vscode.WorkspaceConfiguration,
  docLocale: string
): Promise<{ buffers: (Buffer | null)[]; failed: number } | undefined> {
  const gender = cfg.get<Gender>('preferredGender', 'female');
  const overrides = cfg.get<Record<string, string>>('voiceOverrides', {});
  const pronunciations = cfg.get<Record<string, string>>('pronunciations', {});
  const autoLang = cfg.get<boolean>('perParagraphLanguage', false);
  const fixedLocale = autoLang ? '' : docLocale;
  const fixedVoice = autoLang ? '' : pickVoice(docLocale, gender, overrides);
  const poolSize = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(cfg.get<number>('exportConcurrency', 4))));

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Read Aloud: exporting audio'),
      cancellable: true,
    },
    async (progress, token) => {
      const buffers: (Buffer | null)[] = new Array(chunks.length).fill(null);
      const engines: TtsEngine[] = Array.from({ length: poolSize }, () =>
        engineId === 'supertonic' ? new SupertonicHttpEngine() : new EdgeEngine()
      );
      let cursor = 0;
      let done = 0;
      let failed = 0;
      let firstError: string | undefined;

      const worker = async (engine: TtsEngine) => {
        for (;;) {
          const i = cursor++;
          if (i >= chunks.length || token.isCancellationRequested) return;
          const chunk = chunks[i];
          const clean = applyPronunciations(normalizeForSpeech(chunk.text), pronunciations);
          const locale = fixedLocale || chunk.locale;
          const voice =
            engineId === 'supertonic' ? supertonicVoiceForGender(gender) : fixedVoice || pickVoice(locale, gender, overrides);
          const tooLong = engineId === 'supertonic' && clean.length > SUPERTONIC_MAX_INPUT_LENGTH;

          if (clean && !tooLong) {
            try {
              buffers[i] = await engine.synth(clean, voice, locale);
            } catch (err: any) {
              failed++;
              firstError ??= String(err?.message || err);
            }
          } else if (clean) {
            failed++;
          }

          done++;
          progress.report({
            increment: 100 / chunks.length,
            message: vscode.l10n.t('{0} of {1} sentences', String(done), String(chunks.length)),
          });
        }
      };

      try {
        await Promise.all(engines.map(worker));
      } finally {
        for (const e of engines) e.dispose();
      }

      if (token.isCancellationRequested) return undefined;
      if (failed && !buffers.some((b) => b && b.length)) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Read Aloud: synthesis failed ({0}).', firstError ?? vscode.l10n.t('unknown error'))
        );
      }
      return { buffers, failed };
    }
  );
}
