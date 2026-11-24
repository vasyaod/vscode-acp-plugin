import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AcpApi } from '../../src/extension';
import { VscodeFs } from '../../src/vscodeHost';
import { MockAgent } from '../mockAgent';

// Entry point called by @vscode/test-electron inside the extension host.
export async function run(): Promise<void> {
  const workspace = process.env.ACP_IT_WORKSPACE as string;
  const ext = vscode.extensions.getExtension('vasyaod.vscode-acp-plugin');
  assert.ok(ext, 'extension is installed');
  const api = (await ext.activate()) as AcpApi;

  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['acp.newChat', 'acp.stop', 'acp.setToken', 'acp.signIn', 'acp.signOut', 'acp.focus', 'acp.showOutput']) {
    assert.ok(cmds.includes(c), `command ${c} is registered`);
  }
  await vscode.commands.executeCommand('acp.focus'); // resolves the webview view without throwing

  // ── VscodeFs: unsaved buffers on read, WorkspaceEdit on write ──
  const readme = path.join(workspace, 'README.md');
  const vfs = new VscodeFs();
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(readme));
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, new vscode.Position(0, 0), 'UNSAVED ');
  await vscode.workspace.applyEdit(edit);
  assert.ok(doc.isDirty, 'document is dirty');
  assert.strictEqual(vfs.readOpenDocument(readme), 'UNSAVED # Integration project\n');
  assert.strictEqual(fs.readFileSync(readme, 'utf8'), '# Integration project\n', 'disk still has the old content');

  await vfs.write(readme, 'rewritten by agent\nsecond line\n');
  assert.strictEqual(doc.getText(), 'rewritten by agent\nsecond line\n', 'the open editor shows the agent write');
  assert.strictEqual(doc.isDirty, false, 'and it was saved');
  assert.strictEqual(fs.readFileSync(readme, 'utf8'), 'rewritten by agent\nsecond line\n');
  await vscode.commands.executeCommand('workbench.action.files.revert');

  // ── Full chat turn through the extension against the mock agent ──
  const agent = await MockAgent.start({ token: 'it-token' });
  try {
    const cfg = vscode.workspace.getConfiguration('acp');
    await cfg.update('url', agent.url, vscode.ConfigurationTarget.Global);
    await cfg.update('authMode', 'token', vscode.ConfigurationTarget.Global);
    await cfg.update('autoAllow', true, vscode.ConfigurationTarget.Global);
    await api.credentials.setToken('it-token');

    await api.chat.send('run hostname and pwd, read README.md');
    assert.deepStrictEqual(agent.authHeaders, ['Bearer it-token']);
    const lines = String(agent.observed.terminalOutput.output).trim().split('\n');
    assert.strictEqual(lines[0], os.hostname());
    assert.strictEqual(fs.realpathSync(lines[1]), fs.realpathSync(workspace), 'command ran in the workspace root');
    assert.ok(String(agent.observed.read.content).includes('rewritten by agent'));
    assert.ok(fs.existsSync(path.join(workspace, 'written-by-agent.txt')), 'fs/write_text_file wrote into the workspace');
    const errors = api.chat.items.filter((i) => i.type === 'notice' && i.level === 'error');
    assert.deepStrictEqual(errors, []);
    assert.ok(api.chat.items.some((i) => i.type === 'tool' && i.status === 'completed'));

    await api.chat.send('again');
    assert.strictEqual(agent.sessions.length, 1, 'same session for the second prompt');
    await api.chat.newChat();

    const turn = api.chat.send('slow');
    const t0 = Date.now();
    while (!agent.received.some((r) => r.method === 'session/prompt' && r.params.prompt[0].text === 'slow')) {
      assert.ok(Date.now() - t0 < 5000, 'slow prompt reached the agent');
      await new Promise((r) => setTimeout(r, 20));
    }
    await vscode.commands.executeCommand('acp.stop');
    await turn;
    assert.ok(agent.cancelled, 'ACP: Stop sent session/cancel');
    assert.strictEqual(agent.sessions.length, 2, 'New chat opened a second session');
    console.log('ACP integration: all checks passed');
  } finally {
    api.chat.disconnect();
    await agent.stop();
  }
}
