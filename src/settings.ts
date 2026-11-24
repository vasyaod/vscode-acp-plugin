import * as vscode from 'vscode';
import { AcpError } from './core/errors';
import { AuthMode, ConnectionSettings, buildHeaders } from './core/headers';

const TOKEN_KEY = 'acp.token';
const OAUTH_KEY = 'acp.oauth';

export function readSettings(): ConnectionSettings & { issuer: string; clientId: string; scope: string; showThoughts: boolean } {
  const c = vscode.workspace.getConfiguration('acp');
  return {
    url: c.get<string>('url', ''),
    authMode: c.get<AuthMode>('authMode', 'token'),
    extraHeaders: c.get<Record<string, string>>('extraHeaders', {}),
    issuer: c.get<string>('oauth.issuer', ''),
    clientId: c.get<string>('oauth.clientId', 'vscode-acp-plugin') || 'vscode-acp-plugin',
    scope: c.get<string>('oauth.scope', ''),
    showThoughts: c.get<boolean>('showThoughts', false),
  };
}

/** Tokens live in SecretStorage only, never in settings. */
export class Credentials {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  setToken(token: string): Thenable<void> {
    return this.secrets.store(TOKEN_KEY, token);
  }

  setOAuth(accessToken: string, expiresAt?: number): Thenable<void> {
    return this.secrets.store(OAUTH_KEY, JSON.stringify({ accessToken, expiresAt }));
  }

  async clear(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
    await this.secrets.delete(OAUTH_KEY);
  }

  async has(): Promise<boolean> {
    return Boolean((await this.secrets.get(TOKEN_KEY)) || (await this.secrets.get(OAUTH_KEY)));
  }

  /** The credential for the configured auth mode, or undefined. */
  async current(mode: AuthMode): Promise<string | undefined> {
    if (mode === 'token') return (await this.secrets.get(TOKEN_KEY)) || undefined;
    if (mode === 'oauth') {
      const raw = await this.secrets.get(OAUTH_KEY);
      if (!raw) return undefined;
      try {
        const v = JSON.parse(raw) as { accessToken: string; expiresAt?: number };
        if (v.expiresAt && v.expiresAt < Date.now()) {
          throw new AcpError('auth', 'Your sign-in has expired. Sign in again.');
        }
        return v.accessToken;
      } catch (e) {
        if (e instanceof AcpError) throw e;
        return undefined;
      }
    }
    return undefined;
  }

  async connectionConfig(): Promise<{ url: string; headers: Record<string, string> }> {
    const s = readSettings();
    const secret = await this.current(s.authMode);
    return { url: s.url.trim(), headers: buildHeaders(s, secret) };
  }
}
