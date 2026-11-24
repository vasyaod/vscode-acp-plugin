import WebSocket from 'ws';
import {
  AcpError,
  RPC,
  RpcError,
  errorForClose,
  errorForHandshake,
  errorForNetwork,
  hostOf,
} from './errors';

export type RequestHandler = (method: string, params: any) => Promise<unknown>;
export type NotificationHandler = (method: string, params: any) => void;

export interface ConnectOptions {
  url: string;
  headers?: Record<string, string>;
  handshakeTimeoutMs?: number;
  /** Test seam; defaults to the `ws` package. */
  WebSocketImpl?: typeof WebSocket;
}

/**
 * JSON-RPC 2.0 over a WebSocket, both directions. Knows nothing about ACP
 * methods: the owner installs `onRequest` / `onNotification`.
 */
export class RpcConnection {
  private nextId = 0;
  private readonly pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ended = false;
  private intentional = false;
  private closeError: AcpError | undefined;
  private readonly closeListeners: Array<(err: AcpError | undefined) => void> = [];
  onRequest: RequestHandler = async (method) => {
    throw new RpcError(RPC.METHOD_NOT_FOUND, `method not supported: ${method}`);
  };
  onNotification: NotificationHandler = () => undefined;

  private constructor(
    private readonly ws: WebSocket,
    readonly url: string,
  ) {
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('close', (code, reason) => {
      this.end(this.intentional ? undefined : errorForClose(code, reason.toString(), hostOf(url)));
    });
    ws.on('error', (err) => this.end(errorForNetwork(err, hostOf(url))));
  }

  static connect(opts: ConnectOptions): Promise<RpcConnection> {
    const host = hostOf(opts.url);
    const Impl = opts.WebSocketImpl ?? WebSocket;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new Impl(opts.url, {
          headers: opts.headers ?? {},
          handshakeTimeout: opts.handshakeTimeoutMs ?? 15000,
          maxPayload: 256 * 1024 * 1024,
        });
      } catch (e) {
        reject(new AcpError('config', `Invalid agent URL "${opts.url}": ${(e as Error).message}`));
        return;
      }
      let settled = false;
      const fail = (err: AcpError) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      ws.once('unexpected-response', (req, res) => {
        res.resume();
        req.destroy();
        fail(errorForHandshake(res.statusCode ?? 0, host));
      });
      ws.once('error', (err) => fail(errorForNetwork(err, host)));
      ws.once('close', (code, reason) => fail(errorForClose(code, reason.toString(), host)));
      ws.once('open', () => {
        if (settled) return;
        settled = true;
        resolve(new RpcConnection(ws, opts.url));
      });
    });
  }

  get isOpen(): boolean {
    return !this.ended && this.ws.readyState === WebSocket.OPEN;
  }

  /** Called once when the connection ends; the error is undefined for an intentional close. */
  onClose(cb: (err: AcpError | undefined) => void): void {
    if (this.ended) cb(this.closeError);
    else this.closeListeners.push(cb);
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.ended) {
      return Promise.reject(
        this.closeError ?? new AcpError('dropped', `The connection to ${hostOf(this.url)} is closed.`),
      );
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.ended) this.send({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    if (this.ended) return;
    this.intentional = true;
    try {
      this.ws.close(1000);
    } catch {
      /* already gone */
    }
    this.end(undefined);
  }

  private send(msg: object): void {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      this.end(errorForNetwork(e, hostOf(this.url)));
    }
  }

  private end(err: AcpError | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.closeError = err;
    const reason = err ?? new AcpError('dropped', `The connection to ${hostOf(this.url)} was closed.`);
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
    for (const cb of this.closeListeners.splice(0)) cb(err);
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: RPC.PARSE_ERROR, message: 'parse error' } });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) void this.serve(msg);
      else {
        try {
          this.onNotification(msg.method, msg.params);
        } catch {
          /* notification handlers must not kill the socket */
        }
      }
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code ?? RPC.INTERNAL_ERROR, String(msg.error.message ?? 'error'), msg.error.data));
      else p.resolve(msg.result);
    }
  }

  private async serve(msg: any): Promise<void> {
    try {
      const result = await this.onRequest(msg.method, msg.params ?? {});
      this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : RPC.INTERNAL_ERROR;
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code, message: (e as Error).message ?? String(e) } });
    }
  }
}
