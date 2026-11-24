import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';

export interface MockAgentOptions {
  /** Required bearer token. Missing/other => the socket is closed with 4401 after the upgrade. */
  token?: string;
  /** This token => closed with 4403. */
  forbiddenToken?: string;
  /** Refuse the HTTP upgrade itself with this status (what a real proxy/Starlette does). */
  handshakeStatus?: number;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/**
 * A scripted ACP agent over WebSocket, standing in for a remote agent.
 * Prompt text selects the script: "full" (default), "slow", "perm-wait", "drop", "always", "two-exec".
 */
export class MockAgent {
  readonly wss: WebSocketServer;
  authHeaders: Array<string | undefined> = [];
  /** Everything the client sent that is a request/notification (for assertions). */
  received: Array<{ method: string; params: any }> = [];
  /** Results of the client-side calls the script made. */
  observed: Record<string, any> = {};
  permissionAnswers: any[] = [];
  sessions: string[] = [];
  cancelled = false;
  initParams: any;
  private sockets = new Set<WebSocket>();
  private cancelWaiters: Array<() => void> = [];

  private constructor(private readonly opts: MockAgentOptions, wss: WebSocketServer) {
    this.wss = wss;
  }

  static async start(opts: MockAgentOptions = {}): Promise<MockAgent> {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: '/acp',
      verifyClient: opts.handshakeStatus
        ? (_info, cb) => cb(false, opts.handshakeStatus)
        : undefined,
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const agent = new MockAgent(opts, wss);
    wss.on('connection', (ws, req) => agent.onConnection(ws, req.headers.authorization));
    return agent;
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/acp`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }

  /** Abruptly kill all client sockets (simulates a network drop). */
  dropAll(): void {
    for (const s of this.sockets) s.terminate();
  }

  private onConnection(ws: WebSocket, auth: string | undefined): void {
    this.authHeaders.push(auth);
    if (this.opts.forbiddenToken && auth === `Bearer ${this.opts.forbiddenToken}`) {
      ws.close(4403, 'an agent run may not drive an ACP session');
      return;
    }
    if (this.opts.token !== undefined && auth !== `Bearer ${this.opts.token}`) {
      ws.close(4401, 'missing or invalid credentials');
      return;
    }
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    const pending = new Map<number, Pending>();
    let nextId = 1000;
    const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const call = (method: string, params: any) =>
      new Promise<any>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        send({ jsonrpc: '2.0', id, method, params });
      });
    const update = (sessionId: string, u: object) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
    const chunk = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
        }
        return;
      }
      this.received.push({ method: msg.method, params: msg.params });
      if (msg.method === 'session/cancel') {
        this.cancelled = true;
        for (const w of this.cancelWaiters.splice(0)) w();
        return;
      }
      const reply = (result: any) => send({ jsonrpc: '2.0', id: msg.id, result });
      const fail = (code: number, message: string) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
      try {
        switch (msg.method) {
          case 'initialize':
            this.initParams = msg.params;
            return reply({
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [],
              agentInfo: { name: 'mock-agent', version: '0.0.1' },
            });
          case 'session/new': {
            if (!msg.params?.cwd || !msg.params.cwd.startsWith('/')) return fail(-32602, 'cwd must be absolute');
            const sid = `sess-${this.sessions.length + 1}`;
            this.sessions.push(sid);
            this.observed.cwd = msg.params.cwd;
            return reply({ sessionId: sid });
          }
          case 'session/prompt': {
            const sid = msg.params.sessionId as string;
            const text = (msg.params.prompt?.[0]?.text as string) ?? '';
            this.cancelled = false;
            const stop = await this.turn(text, sid, { call, update, chunk, ws });
            return reply({ stopReason: stop });
          }
          default:
            return fail(-32601, `method not supported: ${msg.method}`);
        }
      } catch (e) {
        fail(-32000, (e as Error).message);
      }
    });
  }

  private waitForCancel(): Promise<void> {
    return new Promise((r) => this.cancelWaiters.push(r));
  }

  private async permission(call: Function, sid: string, kind: string, title: string): Promise<'allow' | 'allow_always' | 'reject' | 'cancelled'> {
    const res = await call('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: `tc-${kind}`, title, kind, status: 'pending', rawInput: { command: title } },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    this.permissionAnswers.push(res);
    if (res?.outcome?.outcome !== 'selected') return 'cancelled';
    return res.outcome.optionId;
  }

  private async runShell(call: Function, sid: string, command: string, limit = 200_000) {
    const { terminalId } = await call('terminal/create', { sessionId: sid, command: '/bin/sh', args: ['-c', command], outputByteLimit: limit });
    const exit = await call('terminal/wait_for_exit', { sessionId: sid, terminalId });
    const out = await call('terminal/output', { sessionId: sid, terminalId });
    await call('terminal/release', { sessionId: sid, terminalId });
    return { exit, out };
  }

  private async turn(text: string, sid: string, io: { call: Function; update: Function; chunk: Function; ws: WebSocket }): Promise<string> {
    const { call, update, chunk } = io;
    switch (text.split(' ')[0]) {
      case 'slow': {
        chunk(sid, 'working…');
        await this.waitForCancel();
        return 'cancelled';
      }
      case 'perm-wait': {
        const d = await this.permission(call, sid, 'execute', 'sleep 1000');
        return d === 'cancelled' ? 'cancelled' : 'end_turn';
      }
      case 'drop': {
        chunk(sid, 'about to drop');
        await new Promise((r) => setTimeout(r, 30));
        this.dropAll();
        await new Promise(() => undefined);
        return 'end_turn';
      }
      case 'always': {
        const a = await this.permission(call, sid, 'execute', 'echo one');
        if (a !== 'reject') await this.runShell(call, sid, 'echo one');
        const b = await this.permission(call, sid, 'execute', 'echo two');
        this.observed.secondPermission = b;
        return 'end_turn';
      }
      case 'big': {
        const { out } = await this.runShell(call, sid, 'head -c 5000 /dev/zero | tr "\\0" x', 100);
        this.observed.big = out;
        return 'end_turn';
      }
      case 'fsreads': {
        const base = text.split(' ')[1];
        this.observed.lines = await call('fs/read_text_file', { sessionId: sid, path: base, line: 2, limit: 2 });
        this.observed.whole = await call('fs/read_text_file', { sessionId: sid, path: base });
        return 'end_turn';
      }
      default: {
        // The scripted turn from the spec.
        chunk(sid, 'Let me look. ');
        update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about hostname' } });
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'hostname && pwd', kind: 'execute', status: 'pending', rawInput: { command: 'hostname && pwd' } });
        const decision = await this.permission(call, sid, 'execute', 'hostname && pwd');
        if (decision === 'cancelled') return 'cancelled';
        if (decision === 'reject') {
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'failed' });
          chunk(sid, 'Refused.');
          return 'end_turn';
        }
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress' });
        const { exit, out } = await this.runShell(call, sid, 'hostname && pwd');
        this.observed.exit = exit;
        this.observed.terminalOutput = out;
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: out.output } }] });
        const cwd = this.observed.cwd as string;
        const read = await call('fs/read_text_file', { sessionId: sid, path: `${cwd}/README.md` });
        this.observed.read = read;
        await call('fs/write_text_file', { sessionId: sid, path: `${cwd}/written-by-agent.txt`, content: `agent saw: ${String(read.content).trim()}\n` });
        chunk(sid, 'Done.');
        return 'end_turn';
      }
    }
  }
}
