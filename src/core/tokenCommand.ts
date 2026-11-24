import { spawn } from 'child_process';
import * as os from 'os';
import { AcpError } from './errors';

export const TOKEN_COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface TokenCommandOptions {
  /** Working directory. Defaults to the home directory, never the workspace (it may be untrusted). */
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** First line of stderr, trimmed and capped, for an error message. */
function firstLine(s: string): string {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Run the user's token command and return the credential it prints.
 *
 * Run through the shell (the setting is one command line, quotes and pipes
 * included), with no stdin and a timeout, at every connect: a command that mints a
 * short-lived token (an auth-service JWT) then always hands over a fresh one.
 * The output is the secret: it never appears in an error, a log line or a notice.
 * Failures are `auth` errors so the chat offers to fix the setting.
 */
export function runTokenCommand(command: string, opts: TokenCommandOptions = {}): Promise<string> {
  const cmd = command.trim();
  if (!cmd) return Promise.reject(new AcpError('config', 'No token command set. Set "acp.tokenCommand" in your user settings.'));
  const timeoutMs = opts.timeoutMs ?? TOKEN_COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd: opts.cwd ?? os.homedir(),
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      reject(new AcpError('auth', `The token command could not start: ${(e as Error).message}`));
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new AcpError('auth', `The token command did not finish within ${Math.round(timeoutMs / 1000)} s.`)));
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      outBytes += b.length;
      if (outBytes <= MAX_OUTPUT_BYTES) out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 4096) err += b.toString('utf8');
    });
    child.on('error', (e) => finish(() => reject(new AcpError('auth', `The token command could not start: ${e.message}`))));
    child.on('close', (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const why = signal ? `killed by ${signal}` : `exit code ${code}`;
          const detail = firstLine(err);
          reject(new AcpError('auth', `The token command failed (${why})${detail ? `: ${detail}` : '.'}`));
          return;
        }
        if (outBytes > MAX_OUTPUT_BYTES) {
          reject(new AcpError('auth', 'The token command printed too much output; it must print only the token.'));
          return;
        }
        const token = Buffer.concat(out).toString('utf8').trim();
        if (!token) {
          reject(new AcpError('auth', 'The token command printed nothing; it must print the token on stdout.'));
          return;
        }
        if (/\s/.test(token)) {
          reject(new AcpError('auth', 'The token command printed more than one word; it must print only the token.'));
          return;
        }
        resolve(token);
      });
    });
  });
}
