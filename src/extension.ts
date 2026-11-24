import * as vscode from 'vscode';
import { ChatController } from './core/chat';
import { AcpError } from './core/errors';
import { signIn } from './core/oauth';
import { ChatViewProvider, VIEW_ID } from './chatView';
import { registerChatParticipant } from './participant';
import { Credentials, readSettings } from './settings';
import { VscodeFs, VscodePermissions, outputTerminalObserver } from './vscodeHost';

/** What tests (and other extensions) get back from activate(). */
export interface AcpApi {
  chat: ChatController;
  credentials: Credentials;
}

export function activate(ctx: vscode.ExtensionContext): AcpApi {
  const out = vscode.window.createOutputChannel('ACP');
  const credentials = new Credentials(ctx.secrets);
  const version = (ctx.extension.packageJSON as { version: string }).version;

  const chat = new ChatController({
    connectionConfig: () => credentials.connectionConfig(),
    cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    clientInfo: { name: 'vscode-acp-plugin', version },
    services: {
      fs: new VscodeFs(),
      permissions: new VscodePermissions(),
      autoAllow: () => vscode.workspace.getConfiguration('acp').get<boolean>('autoAllow', false),
      terminalObserver: outputTerminalObserver(out),
      log: (line) => out.appendLine(`[local] ${line}`),
    },
  });
  chat.onEvent((e) => {
    if (e.type === 'state' || e.type === 'reset') {
      void vscode.commands.executeCommand('setContext', 'acp.running', e.state.running);
    }
    if (e.type === 'add' && e.item.type === 'notice' && e.item.level === 'error') out.appendLine(`[error] ${e.item.text}`);
  });

  const setToken = async () => {
    const token = await vscode.window.showInputBox({
      title: 'ACP: Set Token',
      prompt: 'Bearer token for the remote ACP agent. Stored in the editor secret store, never in settings.',
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined) return;
    if (token.trim() === '') {
      await credentials.clear();
      vscode.window.showInformationMessage('ACP: token removed.');
    } else {
      await credentials.setToken(token.trim());
      vscode.window.showInformationMessage('ACP: token saved.');
    }
    chat.disconnect();
  };

  const doSignIn = async () => {
    const s = readSettings();
    if (!s.url.trim()) {
      vscode.window.showErrorMessage('ACP: set "acp.url" first.');
      return;
    }
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ACP: waiting for the browser sign-in…', cancellable: true },
        (_p, cancel) => {
          const ac = new AbortController();
          cancel.onCancellationRequested(() => ac.abort());
          return signIn({
            endpointUrl: s.url,
            issuer: s.issuer,
            clientId: s.clientId,
            scope: s.scope,
            signal: ac.signal,
            openUrl: async (url) => {
              await vscode.env.openExternal(vscode.Uri.parse(url));
            },
          });
        },
      );
      await credentials.setOAuth(result.accessToken, result.expiresAt);
      if (s.authMode !== 'oauth') {
        await vscode.workspace.getConfiguration('acp').update('authMode', 'oauth', vscode.ConfigurationTarget.Global);
      }
      chat.disconnect();
      vscode.window.showInformationMessage('ACP: signed in.');
    } catch (e) {
      const msg = e instanceof AcpError ? e.message : (e as Error).message;
      out.appendLine(`[sign-in] ${msg}`);
      vscode.window.showErrorMessage(`ACP sign-in failed: ${msg}`);
    }
  };

  const reauth = () => (readSettings().authMode === 'oauth' ? doSignIn() : setToken());
  const view = new ChatViewProvider(ctx, chat, (action) => {
    if (action === 'reauth') void reauth();
    else if (action === 'settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'acp');
  });

  ctx.subscriptions.push(
    out,
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('acp.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('acp.stop', () => chat.stop()),
    vscode.commands.registerCommand('acp.focus', () => vscode.commands.executeCommand('workbench.view.extension.acp')),
    vscode.commands.registerCommand('acp.setToken', setToken),
    vscode.commands.registerCommand('acp.signIn', doSignIn),
    vscode.commands.registerCommand('acp.signOut', async () => {
      await credentials.clear();
      chat.disconnect();
      vscode.window.showInformationMessage('ACP: signed out (stored token and sign-in removed).');
    }),
    vscode.commands.registerCommand('acp.showOutput', () => out.show(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('acp.url') || e.affectsConfiguration('acp.authMode') || e.affectsConfiguration('acp.extraHeaders')) {
        chat.disconnect();
      }
    }),
    { dispose: () => chat.disconnect() },
  );
  registerChatParticipant(ctx, chat);
  return { chat, credentials };
}

export function deactivate(): void {
  /* subscriptions dispose the connection and kill running terminals */
}
