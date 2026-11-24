import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpClient } from '../src/core/client';
import { AcpError } from '../src/core/errors';
import { FsHost, nodeFsHost, sliceLines } from '../src/core/fs';
import { MockAgent } from './mockAgent';
import { CLIENT_INFO, ScriptedPermissions, services, tmpProject, until } from './helpers';

let agent: MockAgent;
let project: string;
beforeEach(async () => {
  agent = await MockAgent.start({ token: 'secret-token' });
  project = tmpProject();
});
afterEach(async () => {
  await agent.stop();
  fs.rmSync(project, { recursive: true, force: true });
});

const connect = (perms: ScriptedPermissions, extra = {}, token = 'secret-token') =>
  AcpClient.connect({
    url: agent.url,
    headers: { Authorization: `Bearer ${token}` },
    services: services(perms, extra),
    clientInfo: CLIENT_INFO,
  });

describe('scripted turn against the mock agent', () => {
  it('runs the commands and file operations locally, in the project dir', async () => {
    const perms = new ScriptedPermissions(['allow']);
    const terminalLog: string[] = [];
    const client = await connect(perms, {
      terminalObserver: {
        started: (_id: string, display: string, cwd: string) => terminalLog.push(`start ${display} @ ${cwd}`),
        data: (_id: string, t: string) => terminalLog.push(`data ${t.trim()}`),
        exited: (_id: string, s: { exitCode: number | null }) => terminalLog.push(`exit ${s.exitCode}`),
      },
    });
    expect(agent.authHeaders).toEqual(['Bearer secret-token']);
    expect(agent.initParams.clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: true }, terminal: true });
    expect(client.agentInfo.name).toBe('mock-agent');

    const session = await client.newSession(project);
    const updates: any[] = [];
    session.onUpdate((u) => updates.push(u));
    const stop = await session.prompt('run hostname and pwd, read README.md');
    expect(stop).toBe('end_turn');

    // The command really ran HERE: hostname is ours and pwd is the project dir.
    const lines = (agent.observed.terminalOutput.output as string).trim().split('\n');
    expect(lines).toEqual([os.hostname(), project]);
    expect(agent.observed.exit).toEqual({ exitCode: 0, signal: null });
    expect(terminalLog[0]).toBe(`start hostname && pwd @ ${project}`);
    expect(terminalLog).toContain('exit 0');

    // fs/read_text_file served the real file; fs/write_text_file wrote into the project.
    expect(agent.observed.read.content).toContain('# Test project');
    expect(fs.readFileSync(path.join(project, 'written-by-agent.txt'), 'utf8')).toBe('agent saw: # Test project\nline two\nline three\nline four\n');

    // Permission prompt happened with the right kind/title and Allow was sent back.
    expect(perms.asked).toHaveLength(1);
    expect(perms.asked[0]).toMatchObject({ kind: 'execute', title: 'hostname && pwd' });
    expect(agent.permissionAnswers[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });

    // Streamed updates arrived in order.
    const kinds = updates.map((u) => u.sessionUpdate);
    expect(kinds[0]).toBe('agent_message_chunk');
    expect(kinds).toContain('tool_call');
    expect(kinds.filter((k) => k === 'tool_call_update')).toHaveLength(2);
    client.close();
  });

  it('reuses the same sessionId for every prompt in a chat', async () => {
    const client = await connect(new ScriptedPermissions(['allow', 'allow']));
    const s = await client.newSession(project);
    await s.prompt('run it');
    await s.prompt('run it again');
    const prompts = agent.received.filter((r) => r.method === 'session/prompt');
    expect(prompts.map((p) => p.params.sessionId)).toEqual([s.id, s.id]);
    expect(agent.sessions).toHaveLength(1);
    client.close();
  });

  it('a rejected permission runs nothing', async () => {
    const perms = new ScriptedPermissions(['reject']);
    const client = await connect(perms);
    const s = await client.newSession(project);
    await s.prompt('go');
    expect(agent.permissionAnswers[0].outcome.optionId).toBe('reject');
    expect(agent.observed.terminalOutput).toBeUndefined();
    expect(fs.existsSync(path.join(project, 'written-by-agent.txt'))).toBe(false);
    client.close();
  });

  it('"Always allow" is remembered per tool kind for the chat', async () => {
    const perms = new ScriptedPermissions(['allow_always']);
    const client = await connect(perms);
    const s = await client.newSession(project);
    await s.prompt('always');
    expect(perms.asked).toHaveLength(1); // the second execute was not asked
    expect(agent.observed.secondPermission).toBe('allow');
    expect(agent.permissionAnswers[0].outcome.optionId).toBe('allow_always');
    client.close();
  });

  it('the autoAllow setting skips the prompt', async () => {
    const perms = new ScriptedPermissions();
    const client = await connect(perms, { autoAllow: () => true });
    const s = await client.newSession(project);
    await s.prompt('go');
    expect(perms.asked).toHaveLength(0);
    expect(agent.observed.terminalOutput.output).toContain(project);
    client.close();
  });

  it('cancel sends session/cancel and the turn ends cancelled', async () => {
    const client = await connect(new ScriptedPermissions());
    const s = await client.newSession(project);
    const turn = s.prompt('slow');
    await until(() => agent.received.some((r) => r.method === 'session/prompt'));
    s.cancel();
    expect(await turn).toBe('cancelled');
    expect(agent.received.some((r) => r.method === 'session/cancel' && r.params.sessionId === s.id)).toBe(true);
    client.close();
  });

  it('cancel while a permission prompt is open answers it as cancelled', async () => {
    const perms = new ScriptedPermissions(['hang']);
    const client = await connect(perms);
    const s = await client.newSession(project);
    const turn = s.prompt('perm-wait');
    await until(() => perms.asked.length === 1);
    s.cancel();
    expect(await turn).toBe('cancelled');
    expect(perms.signals[0].aborted).toBe(true);
    expect(agent.permissionAnswers[0]).toEqual({ outcome: { outcome: 'cancelled' } });
    client.close();
  });
});

describe('local handlers', () => {
  it('honours line/limit and outputByteLimit', async () => {
    const client = await connect(new ScriptedPermissions(['allow', 'allow']));
    const s = await client.newSession(project);
    await s.prompt(`fsreads ${path.join(project, 'README.md')}`);
    expect(agent.observed.lines.content).toBe('line two\nline three\n');
    expect(agent.observed.whole.content).toContain('line four');
    await s.prompt('big');
    expect(agent.observed.big.truncated).toBe(true);
    expect(Buffer.byteLength(agent.observed.big.output)).toBeLessThanOrEqual(100);
    client.close();
  });

  it('prefers an open (unsaved) editor buffer over the disk content', async () => {
    const readme = path.join(project, 'README.md');
    const host: FsHost = {
      readOpenDocument: (p) => (p === readme ? 'UNSAVED BUFFER\nline two\nline three\n' : undefined),
      write: nodeFsHost.write,
    };
    const client = await connect(new ScriptedPermissions(['allow']), { fs: host });
    const s = await client.newSession(project);
    await s.prompt('go');
    expect(agent.observed.read.content).toContain('UNSAVED BUFFER');
    expect(fs.readFileSync(readme, 'utf8')).toContain('# Test project'); // disk untouched
    client.close();
  });

  it('releasing a terminal kills a long-running command', async () => {
    const client = await connect(new ScriptedPermissions());
    const s = await client.newSession(project);
    const marker = `sleep 61${Math.floor(Math.random() * 1000)}`;
    const id = client.terminals.create({ command: '/bin/sh', args: ['-c', marker] }, s.cwd);
    const term = client.terminals.get(id);
    client.terminals.release(id);
    const status = await term.wait();
    expect(status.signal).toBe('SIGKILL');
    client.close();
  });

  it('sliceLines edge cases', () => {
    expect(sliceLines('a\nb\nc', 2)).toBe('b\nc');
    expect(sliceLines('a\nb\nc', undefined, 1)).toBe('a\n');
    expect(sliceLines('a\nb\nc')).toBe('a\nb\nc');
  });
});

describe('errors surface cleanly', () => {
  it('wrong token → close code 4401 → auth error', async () => {
    const err = await connect(new ScriptedPermissions(), {}, 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect(err.kind).toBe('auth');
    expect(err.code).toBe(4401);
    expect(err.message).toMatch(/4401.*Sign in again/);
  });

  it('forbidden token → close code 4403 → forbidden error', async () => {
    await agent.stop();
    agent = await MockAgent.start({ token: 'ok', forbiddenToken: 'run-token' });
    const err = await connect(new ScriptedPermissions(), {}, 'run-token').catch((e) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect(err.kind).toBe('forbidden');
    expect(err.code).toBe(4403);
    expect(err.message).toMatch(/refused access.*4403/);
  });

  it.each([
    [401, 'auth'],
    [403, 'forbidden'],
  ])('HTTP %i at the upgrade → %s error', async (status, kind) => {
    await agent.stop();
    agent = await MockAgent.start({ handshakeStatus: status });
    const err = await connect(new ScriptedPermissions()).catch((e) => e);
    expect(err.kind).toBe(kind);
    expect(err.message).toContain(`HTTP ${status}`);
  });

  it('unreachable host', async () => {
    const dead = await MockAgent.start();
    const url = dead.url;
    await dead.stop();
    const err = await AcpClient.connect({ url, headers: {}, services: services(new ScriptedPermissions()), clientInfo: CLIENT_INFO }).catch((e) => e);
    expect(err.kind).toBe('unreachable');
    expect(err.message).toMatch(/Cannot reach 127\.0\.0\.1.*ECONNREFUSED/);
  });

  it('a dropped connection mid-turn rejects the prompt with a dropped error', async () => {
    const client = await connect(new ScriptedPermissions());
    const s = await client.newSession(project);
    const err = await s.prompt('drop').catch((e) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect(err.kind).toBe('dropped');
    expect(err.message).toMatch(/connection to 127\.0\.0\.1.*lost/);
    expect(client.isOpen).toBe(false);
  });
});

void os;
