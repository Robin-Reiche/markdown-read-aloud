// Headless smoke test: stub the `vscode` module, load the BUILT bundle, and run
// activate() to confirm the bundle loads (msedge-tts/ws, eld, remark, voices.json)
// and registers all commands without throwing.
const Module = require('module');
const path = require('path');

const registered = [];
const disp = { dispose() {} };
const vscodeStub = {
  commands: {
    registerCommand: (id) => { registered.push(id); return disp; },
    executeCommand: () => Promise.resolve(),
  },
  window: {
    createWebviewPanel: () => ({ webview: { postMessage() {}, onDidReceiveMessage() {}, asWebviewUri: () => '', cspSource: '', html: '' }, onDidDispose() {}, reveal() {}, dispose() {} }),
    createTextEditorDecorationType: () => disp,
    visibleTextEditors: [],
    activeTextEditor: undefined,
    showErrorMessage() {}, showInformationMessage() {}, showWarningMessage() {},
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, d) => d, update: () => Promise.resolve() }),
  },
  Uri: { joinPath: () => ({}), parse: (s) => ({ toString: () => s }) },
  ViewColumn: { Beside: 2 },
  ThemeColor: class {},
  Range: class {},
  OverviewRulerLane: { Center: 1 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  ConfigurationTarget: { Global: 1 },
};

const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return orig.apply(this, arguments);
};

const ext = require(path.join(__dirname, '..', 'dist', 'extension.js'));
const ctx = { subscriptions: [], extensionUri: { fsPath: '/x' } };
ext.activate(ctx);
console.log('activate() ok. Commands registered:', registered.length);
console.log(registered.join('\n'));
ext.deactivate && ext.deactivate();
console.log('deactivate() ok.');
