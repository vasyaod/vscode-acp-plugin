import { AcpError } from './errors';

export type AuthMode = 'token' | 'oauth' | 'command' | 'none';

export interface ConnectionSettings {
  url: string;
  authMode: AuthMode;
  extraHeaders: Record<string, string>;
}

/** Validate the URL and build the upgrade headers. Throws AcpError('config' | 'auth'). */
export function buildHeaders(s: ConnectionSettings, secret: string | undefined): Record<string, string> {
  const url = s.url.trim();
  if (!url) throw new AcpError('config', 'No agent URL set. Set "acp.url" in the settings (e.g. wss://agent.example.com/acp).');
  if (!/^wss?:\/\//i.test(url)) {
    throw new AcpError('config', `"acp.url" must start with ws:// or wss:// (got "${url}").`);
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.extraHeaders ?? {})) {
    if (typeof v === 'string') headers[k] = v;
  }
  if (s.authMode === 'token') {
    if (!secret) throw new AcpError('auth', 'No token set. Run "ACP: Set Token".');
    headers['Authorization'] = `Bearer ${secret}`;
  } else if (s.authMode === 'oauth') {
    if (!secret) throw new AcpError('auth', 'Not signed in. Run "ACP: Sign In".');
    headers['Authorization'] = `Bearer ${secret}`;
  } else if (s.authMode === 'command') {
    if (!secret) throw new AcpError('auth', 'The token command gave no token. Check "acp.tokenCommand".');
    headers['Authorization'] = `Bearer ${secret}`;
  }
  return headers;
}
