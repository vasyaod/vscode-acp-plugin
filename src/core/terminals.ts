import { ChildProcess, spawn } from 'child_process';
import { RPC, RpcError } from './errors';

export interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

/** Observer that mirrors terminal activity somewhere the user can see it. */
export interface TerminalObserver {
  started?(id: string, display: string, cwd: string): void;
  data?(id: string, text: string): void;
  exited?(id: string, status: ExitStatus): void;
}

const DEFAULT_LIMIT = 1024 * 1024;

/** One ACP terminal: a local child process with bounded combined output. */
export class LocalTerminal {
  private chunks: Buffer = Buffer.alloc(0);
  truncated = false;
  exitStatus: ExitStatus | null = null;
  private readonly exitPromise: Promise<ExitStatus>;
  private proc?: ChildProcess;

  constructor(
    readonly id: string,
    command: string,
    args: string[],
    cwd: string,
    env: Array<{ name: string; value: string }> | undefined,
    private readonly limit: number,
    private readonly observer: TerminalObserver,
  ) {
    const fullEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const e of env ?? []) if (e && e.name) fullEnv[e.name] = String(e.value ?? '');

    // The agent asks for `/bin/sh -c <command>`; there is no /bin/sh on Windows.
    const isShellCall = (command === '/bin/sh' || command === 'sh' || command === '/bin/bash' || command === 'bash') && args[0] === '-c';
    let file = command;
    let argv = args;
    let shell = false;
    if (process.platform === 'win32' && isShellCall) {
      file = args[1] ?? '';
      argv = [];
      shell = true;
    }
    const display = isShellCall ? String(args[1] ?? '') : [command, ...args].join(' ');
    observer.started?.(id, display, cwd);

    this.exitPromise = new Promise<ExitStatus>((resolve) => {
      let done = false;
      const finish = (status: ExitStatus) => {
        if (done) return;
        done = true;
        this.exitStatus = status;
        observer.exited?.(id, status);
        resolve(status);
      };
      let proc: ChildProcess;
      try {
        proc = spawn(file, argv, {
          cwd,
          env: fullEnv,
          shell,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32', // own process group, so kill() takes the children too
          windowsHide: true,
        });
      } catch (e) {
        this.proc = undefined;
        this.append(Buffer.from(`failed to start: ${(e as Error).message}\n`));
        finish({ exitCode: 127, signal: null });
        return;
      }
      this.proc = proc;
      proc.stdout?.on('data', (b: Buffer) => this.append(b));
      proc.stderr?.on('data', (b: Buffer) => this.append(b));
      proc.on('error', (e) => {
        this.append(Buffer.from(`failed to start: ${e.message}\n`));
        finish({ exitCode: 127, signal: null });
      });
      proc.on('close', (code, signal) => finish({ exitCode: code, signal: signal ?? null }));
    });
  }

  private append(b: Buffer): void {
    this.observer.data?.(this.id, b.toString('utf8'));
    this.chunks = Buffer.concat([this.chunks, b]);
    if (this.chunks.length > this.limit) {
      let start = this.chunks.length - this.limit;
      // Never start in the middle of a UTF-8 sequence.
      while (start < this.chunks.length && (this.chunks[start] & 0xc0) === 0x80) start++;
      this.chunks = this.chunks.subarray(start);
      this.truncated = true;
    }
  }

  output(): string {
    return this.chunks.toString('utf8');
  }

  wait(): Promise<ExitStatus> {
    return this.exitPromise;
  }

  kill(): void {
    if (this.exitStatus || !this.proc || this.proc.pid === undefined) return;
    try {
      if (process.platform === 'win32') this.proc.kill();
      else process.kill(-this.proc.pid, 'SIGKILL');
    } catch {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
  }
}

/** The set of terminals of one connection. */
export class TerminalManager {
  private readonly terminals = new Map<string, LocalTerminal>();
  private seq = 0;

  constructor(private readonly observer: TerminalObserver = {}) {}

  create(p: { command: string; args?: string[]; cwd?: string; env?: any; outputByteLimit?: number }, defaultCwd: string): string {
    if (!p.command) throw new RpcError(RPC.INVALID_PARAMS, 'terminal/create: command is required');
    const id = `term-${++this.seq}`;
    const cwd = p.cwd && p.cwd.length > 0 ? p.cwd : defaultCwd;
    const limit = p.outputByteLimit && p.outputByteLimit > 0 ? Math.floor(p.outputByteLimit) : DEFAULT_LIMIT;
    this.terminals.set(id, new LocalTerminal(id, p.command, p.args ?? [], cwd, p.env, limit, this.observer));
    return id;
  }

  get(id: unknown): LocalTerminal {
    const t = this.terminals.get(String(id));
    if (!t) throw new RpcError(RPC.INVALID_PARAMS, `unknown terminalId ${String(id)}`);
    return t;
  }

  release(id: unknown): void {
    const t = this.terminals.get(String(id));
    if (!t) return;
    t.kill();
    this.terminals.delete(String(id));
  }

  /** Kill everything still running (connection dropped, extension deactivated). */
  disposeAll(): void {
    for (const t of this.terminals.values()) t.kill();
    this.terminals.clear();
  }
}
