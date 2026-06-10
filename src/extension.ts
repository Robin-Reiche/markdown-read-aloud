import * as vscode from 'vscode';
import { PlayerPanel } from './player/playerPanel';
import { titleFor } from './reader';

export function activate(context: vscode.ExtensionContext) {
  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('markdownReadAloud.readDocument', (uriArg?: vscode.Uri) => readDocument(context, uriArg));
  reg('markdownReadAloud.readFromCursor', () => readFromCursor(context));
  reg('markdownReadAloud.readSelection', () => readSelection(context));
  reg('markdownReadAloud.stop', () => PlayerPanel.current?.control('stop'));
  reg('markdownReadAloud.togglePlayPause', () => {
    if (PlayerPanel.current) PlayerPanel.current.control('playpause');
    else vscode.window.showInformationMessage(vscode.l10n.t('Read Aloud: no active player. Run "Read Aloud: Read Document" to start.'));
  });
  reg('markdownReadAloud.openPlayer', () => readDocument(context));
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
  vscode.window.showErrorMessage(vscode.l10n.t('Read Aloud: open a Markdown file first.'));
  return undefined;
}

async function readDocument(context: vscode.ExtensionContext, uriArg?: vscode.Uri) {
  const doc = await resolveDocument(uriArg);
  if (!doc) return;
  const source = doc.getText();
  if (!source.trim()) {
    vscode.window.showInformationMessage(vscode.l10n.t('Read Aloud: nothing readable found in this document.'));
    return;
  }
  PlayerPanel.show(context).open(source, titleFor(doc.uri), { docUri: doc.uri });
}

async function readFromCursor(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage(vscode.l10n.t('Read Aloud: open a Markdown file first.'));
    return;
  }
  const doc = editor.document;
  const source = doc.getText();
  if (!source.trim()) {
    vscode.window.showInformationMessage(vscode.l10n.t('Read Aloud: nothing readable found in this document.'));
    return;
  }
  PlayerPanel.show(context).open(source, titleFor(doc.uri), {
    docUri: doc.uri,
    startOffset: doc.offsetAt(editor.selection.active),
  });
}

async function readSelection(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return readFromCursor(context);
  }
  const source = editor.document.getText(editor.selection);
  if (!source.trim()) {
    vscode.window.showInformationMessage(vscode.l10n.t('Read Aloud: nothing readable in the selection.'));
    return;
  }
  PlayerPanel.show(context).open(source, vscode.l10n.t('{0} (selection)', titleFor(editor.document.uri)), {
    docUri: editor.document.uri,
    isSelection: true,
    baseLine: editor.selection.start.line + 1,
  });
}

export function deactivate() {
  PlayerPanel.current?.dispose();
}
