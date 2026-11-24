import * as path from 'path';
import * as vscode from 'vscode';
import { FsHost } from './core/fs';
import { PermissionDecision, PermissionHost, PermissionRequest } from './core/permissions';
import { ExitStatus, TerminalObserver } from './core/terminals';

function sameFile(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.scheme === b.scheme && (a.fsPath === b.fsPath || (process.platform === 'win32' && a.fsPath.toLowerCase() === b.fsPath.toLowerCase()));
}

function findOpen(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => !d.isClosed && sameFile(d.uri, uri));
}

/** fs for the agent: unsaved editor buffers on read; undoable WorkspaceEdit on write. */
export class VscodeFs implements FsHost {
  readOpenDocument(absPath: string): string | undefined {
    return findOpen(vscode.Uri.file(absPath))?.getText();
  }

  async write(absPath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    let exists = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    if (!exists) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(absPath)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      return;
    }
    let doc: vscode.TextDocument | undefined;
    try {
      doc = findOpen(uri) ?? (await vscode.workspace.openTextDocument(uri));
    } catch {
      // Binary or otherwise un-openable: write the bytes directly.
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      return;
    }
    const old = doc.getText();
    if (old !== content) {
      // Replace only the changed middle, so cursors, folds and undo steps stay sensible.
      let pre = 0;
      const max = Math.min(old.length, content.length);
      while (pre < max && old.charCodeAt(pre) === content.charCodeAt(pre)) pre++;
      let suf = 0;
      while (suf < max - pre && old.charCodeAt(old.length - 1 - suf) === content.charCodeAt(content.length - 1 - suf)) suf++;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(pre), doc.positionAt(old.length - suf)), content.slice(pre, content.length - suf));
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('the editor refused the edit');
    }
    // The agent (and its terminal commands) read the file from disk, so persist it.
    if (doc.isDirty && !(await doc.save())) throw new Error('the editor could not save the file');
  }
}

const KIND_VERB: Record<string, string> = {
  execute: 'run a command',
  edit: 'edit a file',
  delete: 'delete a file',
  move: 'move a file',
  read: 'read a file',
};

/** Native Allow / Always allow / Reject prompt. Dismissing it counts as Reject. */
export class VscodePermissions implements PermissionHost {
  async ask(req: PermissionRequest, _signal: AbortSignal): Promise<PermissionDecision | undefined> {
    const verb = KIND_VERB[req.kind] ?? `use a "${req.kind}" tool`;
    const detail = req.title.length > 2000 ? `${req.title.slice(0, 2000)}…` : req.title;
    const pick = await vscode.window.showInformationMessage(
      `The ACP agent wants to ${verb} in your workspace.`,
      { modal: true, detail },
      'Allow',
      'Always allow',
      'Reject',
    );
    // A modal dialog also has a Cancel button / Esc; closing it is a refusal too.
    if (pick === 'Allow') return 'allow';
    if (pick === 'Always allow') return 'allow_always';
    return 'reject';
  }
}

/** Mirrors every local command into the "ACP" output channel. */
export function outputTerminalObserver(out: vscode.OutputChannel): TerminalObserver {
  return {
    started: (id, display, cwd) => out.appendLine(`[${id}] $ ${display}   (cwd: ${cwd})`),
    data: (id, text) => out.append(text.endsWith('\n') ? text : `${text}`),
    exited: (id, s: ExitStatus) => out.appendLine(`\n[${id}] exited ${s.signal ? `by ${s.signal}` : `with code ${s.exitCode}`}`),
  };
}
