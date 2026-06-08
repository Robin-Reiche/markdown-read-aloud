import * as vscode from 'vscode';
import { PlayerPanel } from './player/playerPanel';
import { buildJob, chunkIndexForOffset, titleFor } from './reader';

export function activate(context: vscode.ExtensionContext) {
  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('markdownReadAloud.readDocument', (uriArg?: vscode.Uri) => readDocument(context, uriArg));
  reg('markdownReadAloud.readFromCursor', () => readFromCursor(context));
  reg('markdownReadAloud.readSelection', () => readSelection(context));
  reg('markdownReadAloud.stop', () => PlayerPanel.current?.control('stop'));
  reg('markdownReadAloud.togglePlayPause', () => {
    if (PlayerPanel.current) PlayerPanel.current.control('playpause');
    else vscode.window.showInformationMessage('Read Aloud: no active player. Run "Read Aloud: Read from Cursor" to start.');
  });
  reg('markdownReadAloud.openPlayer', () => PlayerPanel.show(context.extensionUri));
}

async function resolveDocument(uriArg?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (uriArg) {
    try {
      return await vscode.workspace.openTextDocument(uriArg);
    } catch {
      /* fall through */
    }
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) return editor.document;
  vscode.window.showErrorMessage('Read Aloud: open a Markdown file first.');
  return undefined;
}

async function readDocument(context: vscode.ExtensionContext, uriArg?: vscode.Uri) {
  const doc = await resolveDocument(uriArg);
  if (!doc) return;
  const job = buildJob({ source: doc.getText(), baseOffset: 0, docUri: doc.uri, title: titleFor(doc.uri) });
  if (!job) {
    vscode.window.showInformationMessage('Read Aloud: nothing readable found in this document.');
    return;
  }
  PlayerPanel.show(context.extensionUri).startJob(job, 0);
}

async function readFromCursor(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Read Aloud: open a Markdown file first.');
    return;
  }
  const doc = editor.document;
  const job = buildJob({ source: doc.getText(), baseOffset: 0, docUri: doc.uri, title: titleFor(doc.uri) });
  if (!job) {
    vscode.window.showInformationMessage('Read Aloud: nothing readable found in this document.');
    return;
  }
  const offset = doc.offsetAt(editor.selection.active);
  const startIndex = chunkIndexForOffset(job, offset);
  PlayerPanel.show(context.extensionUri).startJob(job, startIndex);
}

async function readSelection(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return readFromCursor(context);
  }
  const doc = editor.document;
  const sel = editor.selection;
  const source = doc.getText(sel);
  const baseOffset = doc.offsetAt(sel.start);
  const job = buildJob({ source, baseOffset, docUri: doc.uri, title: `${titleFor(doc.uri)} (selection)` });
  if (!job) {
    vscode.window.showInformationMessage('Read Aloud: nothing readable in the selection.');
    return;
  }
  PlayerPanel.show(context.extensionUri).startJob(job, 0);
}

export function deactivate() {
  PlayerPanel.current?.dispose();
}
