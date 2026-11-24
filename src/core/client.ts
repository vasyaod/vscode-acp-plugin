import { RpcConnection, ConnectOptions } from './connection';
import { AcpError, RPC, RpcError } from './errors';
import { FsHost, readTextFile, writeTextFile } from './fs';
import { PermissionHost, PermissionPolicy } from './permissions';
import { TerminalManager, TerminalObserver } from './terminals';

export const PROTOCOL_VERSION = 1;

/** Everything the client needs from the IDE, behind small interfaces. */
export interface ClientServices {
  fs: FsHost;
  permissions: PermissionHost;
  autoAllow: () => boolean;
  terminalObserver?: TerminalObserver;
  /** One line of "what ran locally" output (read/write/terminal), for logs. */
  log?: (line: string) => void;
}

export interface ClientOptions extends ConnectOptions {
  services: ClientServices;
  clientInfo: { name: string; version: string };
}

export type SessionUpdate = { sessionUpdate: string; [k: string]: any };
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string;

/** How long to wait for the agent to confirm a cancel before giving up locally. */
export const CANCEL_GRACE_MS = 15000;

export class AcpSession {
  private listeners = new Set<(u: SessionUpdate) => void>();
  private abort = new AbortController();
  private cancelTimer?: ReturnType<typeof setTimeout>;
  readonly permissions: PermissionPolicy;
  turnRunning = false;

  constructor(
    readonly id: string,
    readonly cwd: string,
    private readonly client: AcpClient,
    services: ClientServices,
  ) {
    this.permissions = new PermissionPolicy(services.permissions, services.autoAllow);
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  onUpdate(cb: (u: SessionUpdate) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** @internal */
  dispatch(u: SessionUpdate): void {
    for (const l of [...this.listeners]) {
      try {
        l(u);
      } catch {
        /* a UI listener must not break the protocol loop */
      }
    }
  }

  /** Run one turn in this session. The sessionId is the same for every prompt in a chat. */
  async prompt(text: string): Promise<StopReason> {
    this.abort = new AbortController();
    this.turnRunning = true;
    try {
      const res = await new Promise<any>((resolve, reject) => {
        this.cancelWaiter = () => resolve({ stopReason: 'cancelled' });
        this.client.conn
          .request('session/prompt', { sessionId: this.id, prompt: [{ type: 'text', text }] })
          .then(resolve, reject);
      });
      return (res?.stopReason as StopReason) ?? 'end_turn';
    } finally {
      this.turnRunning = false;
      this.cancelWaiter = undefined;
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
    }
  }
  private cancelWaiter?: () => void;

  /** Send `session/cancel` and answer any open permission prompt as cancelled. */
  cancel(): void {
    if (!this.turnRunning) return;
    this.abort.abort();
    this.client.conn.notify('session/cancel', { sessionId: this.id });
    // The agent answers the prompt with `cancelled`; don't hang forever if it doesn't.
    this.cancelTimer = setTimeout(() => this.cancelWaiter?.(), CANCEL_GRACE_MS);
  }
}

/** A connected, initialised ACP client. */
export class AcpClient {
  private readonly sessions = new Map<string, AcpSession>();
  readonly terminals: TerminalManager;
  agentInfo: { name?: string; version?: string } = {};
  agentCapabilities: any = {};

  private constructor(
    readonly conn: RpcConnection,
    private readonly services: ClientServices,
  ) {
    this.terminals = new TerminalManager(services.terminalObserver);
    conn.onRequest = (m, p) => this.serve(m, p);
    conn.onNotification = (m, p) => this.notification(m, p);
    conn.onClose(() => {
      this.terminals.disposeAll();
    });
  }

  static async connect(opts: ClientOptions): Promise<AcpClient> {
    const conn = await RpcConnection.connect(opts);
    const client = new AcpClient(conn, opts.services);
    try {
      const init = await conn.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: opts.clientInfo,
      });
      client.agentInfo = init?.agentInfo ?? {};
      client.agentCapabilities = init?.agentCapabilities ?? {};
    } catch (e) {
      conn.close();
      throw e;
    }
    return client;
  }

  get isOpen(): boolean {
    return this.conn.isOpen;
  }

  onClose(cb: (err: AcpError | undefined) => void): void {
    this.conn.onClose(cb);
  }

  async newSession(cwd: string): Promise<AcpSession> {
    const res = await this.conn.request('session/new', { cwd, mcpServers: [] });
    if (!res || typeof res.sessionId !== 'string') {
      throw new AcpError('protocol', 'The agent answered session/new without a sessionId.');
    }
    const s = new AcpSession(res.sessionId, cwd, this, this.services);
    this.sessions.set(s.id, s);
    return s;
  }

  /**
   * How this agent lets a client put an earlier session back on a new connection:
   * standard `session/load` (`loadSession`), agent-swarm's `session/new` extension
   * (`_meta.agentSwarm.resumeSession`, which skips the history replay), or not at all.
   */
  get resumeMethod(): 'load' | 'agentSwarm' | undefined {
    const caps = this.agentCapabilities ?? {};
    if (caps._meta?.agentSwarm?.resumeSession === true) return 'agentSwarm';
    if (caps.loadSession === true) return 'load';
    return undefined;
  }

  /**
   * Re-attach session `id` (from an earlier connection) to this one. Returns the
   * session, or undefined when the agent offers no way to do it. A refusal (busy,
   * unknown session) is thrown as the agent's RpcError.
   *
   * With `session/load` the agent replays the conversation as session/update
   * notifications before it answers; nobody listens to the session yet, so the
   * replay is dropped: the chat already shows it.
   */
  async resumeSession(id: string, cwd: string): Promise<AcpSession | undefined> {
    const how = this.resumeMethod;
    if (!how) return undefined;
    if (how === 'load') {
      const s = new AcpSession(id, cwd, this, this.services);
      this.sessions.set(id, s);
      try {
        await this.conn.request('session/load', { sessionId: id, cwd, mcpServers: [] });
      } catch (e) {
        this.sessions.delete(id);
        throw e;
      }
      return s;
    }
    const res = await this.conn.request('session/new', {
      cwd,
      mcpServers: [],
      _meta: { agentSwarm: { resumeSessionId: id } },
    });
    if (!res || typeof res.sessionId !== 'string') {
      throw new AcpError('protocol', 'The agent answered session/new without a sessionId.');
    }
    const s = new AcpSession(res.sessionId, cwd, this, this.services);
    this.sessions.set(s.id, s);
    return s;
  }

  releaseSession(s: AcpSession): void {
    this.sessions.delete(s.id);
  }

  close(): void {
    this.terminals.disposeAll();
    this.conn.close();
  }

  // ── agent → client ──
  private notification(method: string, params: any): void {
    if (method !== 'session/update') return;
    const s = this.sessions.get(String(params?.sessionId ?? ''));
    const upd = params?.update;
    if (s && upd) s.dispatch(upd);
  }

  private sessionFor(params: any): AcpSession {
    const s = this.sessions.get(String(params?.sessionId ?? ''));
    if (!s) throw new RpcError(RPC.INVALID_PARAMS, `unknown session ${String(params?.sessionId)}`);
    return s;
  }

  private async serve(method: string, params: any): Promise<unknown> {
    const log = this.services.log ?? (() => undefined);
    switch (method) {
      case 'fs/read_text_file': {
        const s = this.sessionFor(params);
        log(`read ${params.path}`);
        return readTextFile(this.services.fs, params, s.cwd);
      }
      case 'fs/write_text_file': {
        const s = this.sessionFor(params);
        log(`write ${params.path} (${String(params.content ?? '').length} chars)`);
        return writeTextFile(this.services.fs, params, s.cwd);
      }
      case 'terminal/create': {
        const s = this.sessionFor(params);
        return { terminalId: this.terminals.create(params, s.cwd) };
      }
      case 'terminal/output': {
        const t = this.terminals.get(params?.terminalId);
        return { output: t.output(), truncated: t.truncated, exitStatus: t.exitStatus };
      }
      case 'terminal/wait_for_exit':
        return { ...(await this.terminals.get(params?.terminalId).wait()) };
      case 'terminal/kill':
        this.terminals.get(params?.terminalId).kill();
        return null;
      case 'terminal/release':
        this.terminals.release(params?.terminalId);
        return null;
      case 'session/request_permission': {
        const s = this.sessionFor(params);
        return s.permissions.handle(params, s.signal);
      }
      default:
        throw new RpcError(RPC.METHOD_NOT_FOUND, `method not supported: ${method}`);
    }
  }
}
