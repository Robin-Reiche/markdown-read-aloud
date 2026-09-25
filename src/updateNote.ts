import * as vscode from 'vscode';
import { isFeatureUpdate } from './featureUpdate';

const LAST_VERSION_KEY = 'markdownReadAloud.lastVersion';
const NOTE_OFF_KEY = 'markdownReadAloud.updateNoteOff';
export const KOFI_URL = 'https://ko-fi.com/robinreiche';

/**
 * After an update to a new feature release, says so once, with a way to the
 * changelog and to Ko-fi. Stays quiet after a first install and a bug-fix
 * release, and for good once "Don't Show Again" is picked.
 */
export async function showUpdateNote(context: vscode.ExtensionContext): Promise<void> {
  const current: string = context.extension.packageJSON.version;
  const previous = context.globalState.get<string>(LAST_VERSION_KEY);
  if (previous === current) return;
  // Versions up to 1.16 stored reader preferences once changed and reading
  // positions per workspace. Someone with neither looks like a first install
  // and gets the first note with the next feature release.
  const usedBefore = [...context.globalState.keys(), ...context.workspaceState.keys()].some((key) =>
    key.startsWith('markdownReadAloud.')
  );
  // Stored before asking, so a note left unanswered does not come back on the next start.
  await context.globalState.update(LAST_VERSION_KEY, current);
  if (!isFeatureUpdate(previous, current, usedBefore) || context.globalState.get<boolean>(NOTE_OFF_KEY)) return;

  const whatsNew = vscode.l10n.t("What's New");
  const coffee = vscode.l10n.t('Buy Me a Coffee');
  const off = vscode.l10n.t("Don't Show Again");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Markdown Read Aloud was updated to {0}. If it saves you time, a coffee on Ko-fi helps keep it free.',
      current
    ),
    whatsNew,
    coffee,
    off
  );
  if (choice === whatsNew) {
    // The extension's own page in VS Code, opened on its Changelog tab.
    await vscode.commands.executeCommand('extension.open', context.extension.id, 'changelog');
  } else if (choice === coffee) {
    await vscode.env.openExternal(vscode.Uri.parse(KOFI_URL));
  } else if (choice === off) {
    await context.globalState.update(NOTE_OFF_KEY, true);
  }
}
