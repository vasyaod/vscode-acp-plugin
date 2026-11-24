import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatController, ChatEvent } from '../src/core/chat';
import { buildHeaders } from '../src/core/headers';
import { AcpError } from '../src/core/errors';
import { MockAgent } from './mockAgent';
import { CLIENT_INFO, ScriptedPermissions, services, tmpProject, until } from './helpers';

let agent: MockAgent;
let project: string;
beforeEach(async () => {
  agent = await MockAgent.start({ token: 'tok' });
  project = tmpProject();
});
afterEach(async () => {
  await agent.stop();
  fs.rmSync(project, { recursive: true, force: true });
});

function controller(perms = new ScriptedPermissions(), token = 'tok') {
  const chat = new ChatController({
    connectionConfig: async () => ({ url: agent.url, headers: buildHeaders({ url: agent.url, authMode: 'token', extraHeaders: { 'X-Test': '1' } }, token) }),
    cwd: () => project,
    services: services(perms),
    clientInfo: CLIENT_INFO,
  });
  const events: ChatEvent[] = [];
  chat.onEvent((e) => events.push(e));
  return { chat, events, perms };
}

describe('ChatController', () => {
  it('streams text, builds a tool card, keeps one session across prompts, and starts a new one on New chat', async () => {
    const { chat, events } = controller(new ScriptedPermissions(['allow', 'allow', 'allow']));
    await chat.send('run hostname and pwd, read README.md');
    expect(agent.authHeaders).toEqual(['Bearer tok']);
    const agentText = chat.items.filter((i) => i.type === 'agent').map((i: any) => i.text).join('|');
    expect(agentText).toContain('Let me look. ');
    expect(agentText).toContain('Done.');
    const tool: any = chat.items.find((i) => i.type === 'tool');
    expect(tool).toMatchObject({ kind: 'execute', title: 'hostname && pwd', status: 'completed' });
    expect(tool.content).toContain(project);
    expect(chat.items.some((i) => i.type === 'thought')).toBe(true);
    expect(events.some((e) => e.type === 'append')).toBe(false); // chunks were separated by non-text items
    expect(chat.state.running).toBe(false);
    expect(chat.state.connection).toBe('connected');

    await chat.send('again');
    expect(agent.sessions).toHaveLength(1);
    const ids = agent.received.filter((r) => r.method === 'session/prompt').map((r) => r.params.sessionId);
    expect(new Set(ids).size).toBe(1);

    await chat.newChat();
    expect(chat.items).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('reset');
    await chat.send('third');
    expect(agent.sessions).toHaveLength(2); // a fresh session/new on the same connection
    expect(agent.authHeaders).toHaveLength(1); // ... without reconnecting
    chat.disconnect();
  });

  it('Stop sends session/cancel and the chat is usable afterwards', async () => {
    const { chat } = controller();
    const turn = chat.send('slow');
    await until(() => agent.received.some((r) => r.method === 'session/prompt'));
    expect(chat.state.running).toBe(true);
    chat.stop();
    await turn;
    expect(chat.state.running).toBe(false);
    expect(agent.cancelled).toBe(true);
    expect(chat.items.some((i) => i.type === 'notice' && i.text === 'Stopped.')).toBe(true);
    chat.disconnect();
  });

  it('a wrong token becomes an error notice that offers re-auth', async () => {
    const { chat } = controller(undefined, 'wrong');
    await chat.send('hello');
    const n: any = chat.items.find((i) => i.type === 'notice');
    expect(n).toMatchObject({ level: 'error', action: 'reauth' });
    expect(n.text).toMatch(/4401/);
    expect(chat.state.running).toBe(false);
  });

  it('after a mid-turn drop the next prompt reconnects with a NEW session', async () => {
    const { chat } = controller(new ScriptedPermissions(['allow']));
    await chat.send('drop');
    const lost = chat.items.filter((i) => i.type === 'notice' && i.level === 'error');
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.some((n: any) => /connection to 127\.0\.0\.1.*lost/.test(n.text))).toBe(true);
    expect(chat.state.running).toBe(false);

    await chat.send('hello again');
    expect(agent.sessions).toHaveLength(2);
    expect(agent.authHeaders).toHaveLength(2);
    expect(chat.items.some((i) => i.type === 'notice' && /new session/i.test((i as any).text))).toBe(true);
    chat.disconnect();
  });

  it('refuses to work without an open folder', async () => {
    const chat = new ChatController({
      connectionConfig: async () => ({ url: agent.url, headers: {} }),
      cwd: () => undefined,
      services: services(new ScriptedPermissions()),
      clientInfo: CLIENT_INFO,
    });
    await chat.send('hi');
    expect(chat.items.find((i) => i.type === 'notice')).toMatchObject({ level: 'error' });
    expect((chat.items.find((i) => i.type === 'notice') as any).text).toMatch(/Open a folder/);
  });
});

describe('buildHeaders', () => {
  const base = { url: 'wss://x/acp', extraHeaders: {} };
  it('puts the token in Authorization, over any extra header of the same name', () => {
    const h = buildHeaders({ ...base, authMode: 'token', extraHeaders: { Authorization: 'x', 'X-A': 'b' } }, 'abc');
    expect(h).toEqual({ Authorization: 'Bearer abc', 'X-A': 'b' });
  });
  it('none mode sends no credentials', () => {
    expect(buildHeaders({ ...base, authMode: 'none' }, 'ignored')).toEqual({});
  });
  it.each([
    [{ ...base, authMode: 'token' as const }, 'auth', /Set Token/],
    [{ ...base, authMode: 'oauth' as const }, 'auth', /Sign In/],
    [{ url: '', authMode: 'none' as const, extraHeaders: {} }, 'config', /acp\.url/],
    [{ url: 'http://x', authMode: 'none' as const, extraHeaders: {} }, 'config', /ws:\/\//],
  ])('validates settings', (s, kind, msg) => {
    try {
      buildHeaders(s, undefined);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AcpError);
      expect((e as AcpError).kind).toBe(kind);
      expect((e as AcpError).message).toMatch(msg);
    }
  });
});
