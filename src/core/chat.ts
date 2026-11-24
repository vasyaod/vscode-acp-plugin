import { AcpClient, AcpSession, ClientServices, SessionUpdate } from './client';
import { AcpError, CLOSE_AUTH, RpcError } from './errors';

export type ChatItem =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'agent'; text: string }
  | { id: string; type: 'thought'; text: string }
  | {
      id: string;
      type: 'tool';
      toolCallId: string;
      title: string;
      kind: string;
      status: string;
      content: string;
      locations: string[];
    }
  | { id: string; type: 'notice'; level: 'info' | 'error'; text: string; action?: 'reauth' | 'settings' };

type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'id'> : never) : never;

export type Connection = 'idle' | 'connecting' | 'connected' | 'error';
export interface ChatState {
  running: boolean;
  connection: Connection;
  agent?: string;
  sessionId?: string;
}

export type ChatEvent =
  | { type: 'reset'; items: ChatItem[]; state: ChatState }
  | { type: 'add'; item: ChatItem }
  | { type: 'update'; item: ChatItem }
  | { type: 'append'; id: string; text: string }
  | { type: 'state'; state: ChatState };

export interface ChatDeps {
  /** Resolve URL + headers from settings and the secret store. Throws AcpError('config'|'auth'). */
  connectionConfig(): Promise<{ url: string; headers: Record<string, string> }>;
  /** Absolute project root, or undefined if no folder is open. */
  cwd(): string | undefined;
  services: ClientServices;
  clientInfo: { name: string; version: string };
  /** Connect factory; tests may override. */
  connect?: typeof AcpClient.connect;
  /**
   * True when every connect fetches a fresh credential (the token command). A 4401
   * close of an established connection is then a token that ran out, not a wrong one:
   * the next prompt reconnects, so it is not reported as an error.
   */
  renewsCredentials?: () => boolean;
  /** How long a re-attach keeps retrying while the agent says the session is busy. */
  resumeRetryMs?: number;
  resumeRetryDelayMs?: number;
}

/** JSON-RPC error the agent answers while the session still has a turn ending (agent-swarm's TURN_BUSY). */
export const SESSION_BUSY = -32001;

/** Extract plain text from ACP tool-call content blocks. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content as any[]) {
    if (c?.type === 'content' && c.content?.type === 'text') parts.push(String(c.content.text ?? ''));
    else if (c?.type === 'diff') parts.push(`diff: ${c.path ?? ''}`);
    else if (c?.type === 'terminal') parts.push(`terminal ${c.terminalId ?? ''}`);
    else if (c?.type === 'text') parts.push(String(c.text ?? ''));
  }
  return parts.join('\n');
}

const MAX_CARD_TEXT = 20_000;

/**
 * The chat model + connection lifecycle, with no `vscode` imports. The webview and the
 * Copilot Chat participant are both thin renderers over this.
 */
export class ChatController {
  items: ChatItem[] = [];
  state: ChatState = { running: false, connection: 'idle' };
  private client?: AcpClient;
  private session?: AcpSession;
  private seq = 0;
  private listeners = new Set<(e: ChatEvent) => void>();
  private lostContext = false;
  /** The session of a connection that dropped, to re-attach on the next prompt. */
  private resumeId?: string;
  private generation = 0;

  constructor(private readonly deps: ChatDeps) {}

  onEvent(cb: (e: ChatEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: ChatEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* renderer errors must not break the chat */
      }
    }
  }

  private setState(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    this.emit({ type: 'state', state: this.state });
  }

  private add(item: NewItem): ChatItem {
    const full = { ...item, id: `i${++this.seq}` } as ChatItem;
    this.items.push(full);
    this.emit({ type: 'add', item: full });
    return full;
  }

  notice(text: string, level: 'info' | 'error' = 'info', action?: 'reauth' | 'settings'): void {
    this.add({ type: 'notice', level, text, action });
  }

  /** Send one prompt in the current chat (connecting / creating the session if needed). */
  async send(text: string): Promise<string | undefined> {
    text = text.trim();
    if (!text) return undefined;
    if (this.state.running) {
      this.notice('A turn is already running. Press Stop first.', 'error');
      return undefined;
    }
    this.add({ type: 'user', text });
    this.setState({ running: true });
    const gen = this.generation;
    try {
      const session = await this.ensureSession();
      const off = session.onUpdate((u) => this.onUpdate(u));
      try {
        const stop = await session.prompt(text);
        if (gen === this.generation && stop === 'cancelled') this.notice('Stopped.', 'info');
        else if (stop !== 'end_turn' && gen === this.generation) this.notice(`Turn ended: ${stop}.`, 'info');
        return stop;
      } finally {
        off();
      }
    } catch (e) {
      if (gen === this.generation) this.reportError(e);
      return undefined;
    } finally {
      if (gen === this.generation) this.setState({ running: false });
    }
  }

  private reportError(e: unknown): void {
    if (e instanceof AcpError) {
      this.notice(e.message, 'error', e.needsReauth ? 'reauth' : e.kind === 'config' ? 'settings' : undefined);
      if (e.kind !== 'protocol') this.setState({ connection: 'error' });
    } else if (e instanceof RpcError) {
      this.notice(`The agent reported an error: ${e.message} (code ${e.code})`, 'error');
    } else {
      this.notice(`Unexpected error: ${(e as Error)?.message ?? String(e)}`, 'error');
    }
  }

  private async ensureSession(): Promise<AcpSession> {
    if (this.client && !this.client.isOpen) this.dropClient();
    if (!this.client) {
      const cwd = this.deps.cwd();
      if (!cwd) throw new AcpError('config', 'Open a folder first: the agent works in your workspace root.');
      const { url, headers } = await this.deps.connectionConfig();
      this.setState({ connection: 'connecting' });
      const connect = this.deps.connect ?? AcpClient.connect;
      const client = await connect({ url, headers, services: this.deps.services, clientInfo: this.deps.clientInfo });
      this.client = client;
      client.onClose((err) => {
        if (this.client !== client) return;
        this.dropClient();
        this.setState({ connection: 'error', running: false });
        if (err && err.code === CLOSE_AUTH && this.deps.renewsCredentials?.()) {
          this.setState({ connection: 'idle' });
          this.notice('The agent closed the connection because its token expired. The next prompt reconnects with a fresh one.', 'info');
        } else if (err) {
          this.notice(err.message, 'error', err.needsReauth ? 'reauth' : undefined);
        }
      });
      this.setState({ connection: 'connected', agent: client.agentInfo?.name });
    }
    if (!this.session) {
      const cwd = this.deps.cwd();
      if (!cwd) throw new AcpError('config', 'Open a folder first: the agent works in your workspace root.');
      const resumeId = this.resumeId;
      this.resumeId = undefined;
      const resumed = resumeId ? await this.tryResume(this.client, resumeId, cwd) : undefined;
      if (resumed && resumed.id === resumeId) {
        this.session = resumed;
        this.lostContext = false;
        this.notice('Reconnected. The conversation continues in the same session.', 'info');
      } else {
        this.session = resumed ?? (await this.client.newSession(cwd));
        if (this.lostContext) {
          this.lostContext = false;
          this.notice('Reconnected with a new session. The earlier conversation is not restored by the agent.', 'info');
        }
      }
      this.setState({ sessionId: this.session.id });
    }
    return this.session;
  }

  /**
   * Put the dropped connection's session back on `client`, if the agent supports it.
   * A "busy" answer (the old turn is still ending on the agent) is retried; any other
   * refusal falls back to a new session. Connection errors propagate.
   */
  private async tryResume(client: AcpClient, id: string, cwd: string): Promise<AcpSession | undefined> {
    const deadline = Date.now() + (this.deps.resumeRetryMs ?? 20_000);
    const delay = this.deps.resumeRetryDelayMs ?? 1000;
    for (;;) {
      try {
        return await client.resumeSession(id, cwd);
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        if (e.code === SESSION_BUSY && Date.now() + delay < deadline) {
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        this.notice(`The agent could not re-attach the earlier session: ${e.message}`, 'info');
        return undefined;
      }
    }
  }

  private dropClient(): void {
    if (this.session) {
      this.lostContext = this.items.length > 0;
      if (this.lostContext) this.resumeId = this.session.id;
    }
    this.client?.terminals.disposeAll();
    this.client = undefined;
    this.session = undefined;
    this.setState({ sessionId: undefined });
  }

  /** `session/cancel`. The turn ends with stopReason "cancelled". */
  stop(): void {
    if (this.session?.turnRunning) {
      this.session.cancel();
      this.notice('Stopping…', 'info');
    }
  }

  /** Start a new chat: a fresh session/new (same connection if it is still open). */
  async newChat(): Promise<void> {
    this.generation++;
    this.session?.cancel();
    if (this.session) this.client?.releaseSession(this.session);
    this.client?.terminals.disposeAll();
    this.session = undefined;
    this.lostContext = false;
    this.resumeId = undefined;
    this.items = [];
    this.setState({ running: false, sessionId: undefined });
    this.emit({ type: 'reset', items: this.items, state: this.state });
  }

  /** Drop the connection (token changed, signed out, deactivation). */
  disconnect(): void {
    this.generation++;
    this.client?.close();
    this.client = undefined;
    this.session = undefined;
    this.resumeId = undefined;
    this.setState({ connection: 'idle', running: false, sessionId: undefined });
  }

  // ── agent updates → items ──
  private last(): ChatItem | undefined {
    return this.items[this.items.length - 1];
  }

  private appendText(type: 'agent' | 'thought', text: string): void {
    if (!text) return;
    const last = this.last();
    if (last && last.type === type) {
      last.text += text;
      this.emit({ type: 'append', id: last.id, text });
    } else {
      this.add({ type, text });
    }
  }

  private onUpdate(u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        this.appendText('agent', String(u.content?.text ?? ''));
        break;
      case 'agent_thought_chunk':
        this.appendText('thought', String(u.content?.text ?? ''));
        break;
      case 'tool_call': {
        const existing = this.findTool(u.toolCallId);
        const fields = {
          title: String(u.title ?? 'tool'),
          kind: String(u.kind ?? 'other'),
          status: String(u.status ?? 'pending'),
          content: contentText(u.content),
          locations: Array.isArray(u.locations) ? u.locations.map((l: any) => String(l?.path ?? '')).filter(Boolean) : [],
        };
        if (existing) {
          Object.assign(existing, fields);
          this.emit({ type: 'update', item: existing });
        } else {
          this.add({ type: 'tool', toolCallId: String(u.toolCallId ?? ''), ...fields });
        }
        break;
      }
      case 'tool_call_update': {
        const t = this.findTool(u.toolCallId);
        if (!t) break;
        if (u.title) t.title = String(u.title);
        if (u.kind) t.kind = String(u.kind);
        if (u.status) t.status = String(u.status);
        if (u.content !== undefined) t.content = contentText(u.content).slice(0, MAX_CARD_TEXT);
        this.emit({ type: 'update', item: t });
        break;
      }
      default:
        break;
    }
  }

  private findTool(id: unknown): Extract<ChatItem, { type: 'tool' }> | undefined {
    return this.items.find((i): i is Extract<ChatItem, { type: 'tool' }> => i.type === 'tool' && i.toolCallId === String(id));
  }
}
