import * as fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatController } from '../src/core/chat';
import { buildHeaders } from '../src/core/headers';
import { MockAgent, MockAgentOptions } from './mockAgent';
import { CLIENT_INFO, ScriptedPermissions, services, tmpProject, until } from './helpers';

let agent: MockAgent | undefined;
let project: string | undefined;
afterEach(async () => {
  await agent?.stop();
  if (project) fs.rmSync(project, { recursive: true, force: true });
  agent = undefined;
  project = undefined;
});

/** A chat whose every connect mints a new token (`jwt-1`, `jwt-2`, …), like the token command. */
async function setup(opts: MockAgentOptions, renews = true) {
  agent = await MockAgent.start({ token: 'never-this', tokenPrefix: 'jwt-', ...opts });
  project = tmpProject();
  const a = agent;
  let n = 0;
  const chat = new ChatController({
    connectionConfig: async () => ({ url: a.url, headers: buildHeaders({ url: a.url, authMode: 'command', extraHeaders: {} }, `jwt-${++n}`) }),
    cwd: () => project,
    services: services(new ScriptedPermissions()),
    clientInfo: CLIENT_INFO,
    renewsCredentials: () => renews,
    resumeRetryDelayMs: 20,
    resumeRetryMs: 2000,
  });
  return { chat, agent: a };
}

const texts = (chat: ChatController, type: string) => chat.items.filter((i) => i.type === type).map((i: any) => i.text as string);

async function dropBetweenTurns(chat: ChatController, a: MockAgent) {
  a.dropAll();
  await until(() => chat.state.connection === 'error');
}

describe('re-attach after a dropped connection', () => {
  it('agent-swarm style: session/new + _meta.agentSwarm.resumeSessionId keeps the same session', async () => {
    const { chat, agent: a } = await setup({ resume: 'agentSwarm' });
    await chat.send('recall first');
    await dropBetweenTurns(chat, a);
    await chat.send('recall second');

    expect(a.authHeaders).toEqual(['Bearer jwt-1', 'Bearer jwt-2']);
    expect(a.sessions).toEqual(['sess-1']);
    expect(a.resumed).toEqual(['sess-1']);
    const resumeCall = a.received.filter((r) => r.method === 'session/new').at(-1)!;
    expect(resumeCall.params._meta).toEqual({ agentSwarm: { resumeSessionId: 'sess-1' } });
    expect(texts(chat, 'agent').at(-1)).toBe('you said: recall first');
    expect(texts(chat, 'notice').some((t) => /continues in the same session/.test(t))).toBe(true);
    expect(texts(chat, 'notice').some((t) => /new session/.test(t))).toBe(false);
    expect(chat.state.sessionId).toBe('sess-1');
    chat.disconnect();
  });

  it('standard session/load: same session, and the replayed history is not shown twice', async () => {
    const { chat, agent: a } = await setup({ resume: 'load' });
    await chat.send('recall first');
    await dropBetweenTurns(chat, a);
    await chat.send('recall second');

    expect(a.received.filter((r) => r.method === 'session/load').map((r) => r.params.sessionId)).toEqual(['sess-1']);
    expect(a.sessions).toEqual(['sess-1']);
    expect(texts(chat, 'agent').at(-1)).toBe('you said: recall first');
    expect(texts(chat, 'agent').some((t) => t.includes('REPLAYED'))).toBe(false);
    chat.disconnect();
  });

  it('a busy answer (-32001) is retried until the old turn has ended', async () => {
    const { chat, agent: a } = await setup({ resume: 'agentSwarm', busyResumes: 2 });
    await chat.send('recall first');
    await dropBetweenTurns(chat, a);
    await chat.send('recall second');

    const attempts = a.received.filter((r) => r.method === 'session/new' && r.params._meta);
    expect(attempts).toHaveLength(3);
    expect(a.resumed).toEqual(['sess-1']);
    expect(texts(chat, 'agent').at(-1)).toBe('you said: recall first');
    chat.disconnect();
  });

  it('a refused re-attach falls back to a new session and says so', async () => {
    const { chat, agent: a } = await setup({ resume: 'agentSwarm' });
    await chat.send('recall first');
    await dropBetweenTurns(chat, a);
    a.sessions.length = 0; // the agent restarted and forgot the session ...
    a.history.clear(); // ... and its conversation
    await chat.send('recall second');

    expect(a.resumed).toEqual([]);
    expect(chat.state.sessionId).toBe('sess-1'); // the agent's new numbering starts again
    const notices = texts(chat, 'notice');
    expect(notices.some((t) => /could not re-attach.*session not found/.test(t))).toBe(true);
    expect(notices.some((t) => /new session/.test(t))).toBe(true);
    expect(texts(chat, 'agent').at(-1)).toBe('you said: ');
    chat.disconnect();
  });

  it('New chat after a drop starts fresh instead of re-attaching', async () => {
    const { chat, agent: a } = await setup({ resume: 'agentSwarm' });
    await chat.send('recall first');
    await dropBetweenTurns(chat, a);
    await chat.newChat();
    await chat.send('recall second');
    expect(a.resumed).toEqual([]);
    expect(a.sessions).toEqual(['sess-1', 'sess-2']);
    chat.disconnect();
  });
});

describe('token expiry close (4401 on an open connection)', () => {
  it('with a renewing credential: an info notice, then a fresh token and the same session', async () => {
    const { chat, agent: a } = await setup({ resume: 'agentSwarm' });
    await chat.send('recall first');
    a.closeAll(4401, 'auth-service token expired: reconnect with a fresh one');
    await until(() => chat.state.connection === 'idle');

    const errors = chat.items.filter((i) => i.type === 'notice' && i.level === 'error');
    expect(errors).toEqual([]);
    expect(texts(chat, 'notice').some((t) => /token expired.*next prompt reconnects/.test(t))).toBe(true);

    await chat.send('recall second');
    expect(a.authHeaders).toEqual(['Bearer jwt-1', 'Bearer jwt-2']);
    expect(a.resumed).toEqual(['sess-1']);
    expect(texts(chat, 'agent').at(-1)).toBe('you said: recall first');
    chat.disconnect();
  });

  it('with a static token: still an error that offers re-auth', async () => {
    const { chat, agent: a } = await setup({ resume: 'agentSwarm' }, false);
    await chat.send('recall first');
    a.closeAll(4401, 'missing or invalid credentials');
    await until(() => chat.state.connection === 'error');
    const n: any = chat.items.find((i) => i.type === 'notice' && i.level === 'error');
    expect(n).toMatchObject({ action: 'reauth' });
    expect(n.text).toMatch(/4401/);
    chat.disconnect();
  });
});
