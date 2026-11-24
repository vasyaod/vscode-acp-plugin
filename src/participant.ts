import * as vscode from 'vscode';
import { ChatController } from './core/chat';

/**
 * Optional extra: `@acp` in Copilot Chat. Registered only when the chat API exists, so the
 * extension activates fine without Copilot (and in Cursor, which has no such API).
 * It shares the one ChatController with the webview, so both see the same session.
 */
export function registerChatParticipant(ctx: vscode.ExtensionContext, chat: ChatController): void {
  const api = (vscode as any).chat as typeof vscode.chat | undefined;
  if (!api || typeof api.createChatParticipant !== 'function') return;
  try {
    const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
      const sub = chat.onEvent((e) => {
        if (e.type === 'add') {
          const it = e.item;
          if (it.type === 'agent') stream.markdown(it.text);
          else if (it.type === 'tool') stream.progress(`${it.kind}: ${it.title}`);
          else if (it.type === 'notice' && it.level === 'error') stream.markdown(`\n\n**${it.text}**\n`);
        } else if (e.type === 'append') {
          const it = chat.items.find((i) => i.id === e.id);
          if (it?.type === 'agent') stream.markdown(e.text);
        }
      });
      const cancel = token.onCancellationRequested(() => chat.stop());
      try {
        await chat.send(request.prompt);
      } finally {
        sub();
        cancel.dispose();
      }
      return {};
    };
    const p = api.createChatParticipant('acp.agent', handler);
    p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
    ctx.subscriptions.push(p);
  } catch {
    /* chat API present but participant registration refused: the webview still works */
  }
}
