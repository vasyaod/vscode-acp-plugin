import * as vscode from 'vscode';
import { ChatController, ChatEvent } from './core/chat';
import { readSettings } from './settings';

export const VIEW_ID = 'acp.chatView';

/** The primary UI: a webview in its own activity-bar container. Works in Cursor too. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly chat: ChatController,
    private readonly runAction: (action: string) => void,
  ) {
    chat.onEvent((e) => this.post(e));
  }

  private post(msg: ChatEvent | { type: 'init'; items: unknown; state: unknown; showThoughts: boolean }): void {
    void this.view?.webview.postMessage(msg);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: any) => {
      switch (m?.type) {
        case 'ready':
          this.post({ type: 'init', items: this.chat.items, state: this.chat.state, showThoughts: readSettings().showThoughts });
          break;
        case 'send':
          void this.chat.send(String(m.text ?? ''));
          break;
        case 'stop':
          this.chat.stop();
          break;
        case 'newChat':
          void this.chat.newChat();
          break;
        case 'action':
          this.runAction(String(m.action));
          break;
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  reveal(): void {
    this.view?.show?.(false);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}"><title>ACP</title></head>
<body>
<div id="status" class="status"></div>
<div id="log" class="log" aria-live="polite"></div>
<div class="composer">
  <textarea id="input" rows="3" placeholder="Message the agent (Enter to send, Shift+Enter for a new line)"></textarea>
  <div class="buttons">
    <button id="newChat" class="secondary" title="Start a new session">New chat</button>
    <span class="spacer"></span>
    <button id="stop" class="danger" title="Cancel the running turn" hidden>Stop</button>
    <button id="send">Send</button>
  </div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
