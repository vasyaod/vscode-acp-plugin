import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { AcpError } from './errors';

export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported?: string[];
}

export interface OAuthOptions {
  /** The agent's WebSocket URL; its origin is probed for RFC 9728 metadata. */
  endpointUrl: string;
  /** Configured issuer, used when the endpoint publishes no resource metadata. */
  issuer?: string;
  clientId: string;
  scope?: string;
  /** Opens the authorization URL in the user's browser. */
  openUrl: (url: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Aborts a pending sign-in. */
  signal?: AbortSignal;
}

export interface OAuthResult {
  accessToken: string;
  /** Epoch ms, if the server said `expires_in`. */
  expiresAt?: number;
  refreshToken?: string;
  tokenType?: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48)); // 64 chars, within RFC 7636's 43..128
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function httpOrigin(wsUrl: string): string {
  const u = new URL(wsUrl);
  const proto = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:';
  return `${proto}//${u.host}`;
}

async function getJson(f: typeof fetch, url: string): Promise<any | undefined> {
  try {
    const res = await f(url, { headers: { Accept: 'application/json' }, redirect: 'manual' });
    if (res.status !== 200) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** RFC 8414 well-known URLs for an issuer (path-aware form first, then the appended form). */
function asMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const p = u.pathname.replace(/\/+$/, '');
  const urls = [`${u.origin}/.well-known/oauth-authorization-server${p}`];
  if (p) urls.push(`${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`);
  return urls;
}

/**
 * Generic discovery: RFC 9728 protected-resource metadata on the endpoint's origin,
 * else the configured issuer, then RFC 8414 authorization-server metadata.
 */
export async function discover(opts: Pick<OAuthOptions, 'endpointUrl' | 'issuer' | 'fetchImpl'>): Promise<AuthServerMetadata> {
  const f = opts.fetchImpl ?? fetch;
  let issuer: string | undefined;
  const origin = httpOrigin(opts.endpointUrl);
  const prm = await getJson(f, `${origin}/.well-known/oauth-protected-resource`);
  if (prm && Array.isArray(prm.authorization_servers) && typeof prm.authorization_servers[0] === 'string') {
    issuer = prm.authorization_servers[0];
  }
  if (!issuer && opts.issuer && opts.issuer.trim()) issuer = opts.issuer.trim();
  if (!issuer) {
    throw new AcpError(
      'config',
      `Cannot sign in: ${new URL(origin).host} publishes no /.well-known/oauth-protected-resource and no "acp.oauth.issuer" is configured.`,
    );
  }
  for (const url of asMetadataUrls(issuer)) {
    const md = await getJson(f, url);
    if (md && typeof md.authorization_endpoint === 'string' && typeof md.token_endpoint === 'string') {
      const methods: string[] | undefined = md.code_challenge_methods_supported;
      if (methods && !methods.includes('S256')) {
        throw new AcpError('config', `The authorization server ${issuer} does not support PKCE S256.`);
      }
      return md as AuthServerMetadata;
    }
  }
  throw new AcpError('config', `Could not read OAuth metadata for ${issuer} (/.well-known/oauth-authorization-server).`);
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em"><h2>${title}</h2><p>${body}</p>`;

/** Authorization code + PKCE (S256) with a loopback redirect on 127.0.0.1:<random>. */
export async function signIn(opts: OAuthOptions): Promise<OAuthResult> {
  const f = opts.fetchImpl ?? fetch;
  const md = await discover(opts);
  const { verifier, challenge } = makePkce();
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AcpError('auth', 'Sign-in timed out: the browser never came back.')),
      opts.timeoutMs ?? 5 * 60_000,
    );
    opts.signal?.addEventListener('abort', () => reject(new AcpError('auth', 'Sign-in cancelled.')));
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get('error');
      const fail = (msg: string) => {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(PAGE('Sign-in failed', msg));
        clearTimeout(timer);
        reject(new AcpError('auth', `Sign-in failed: ${msg}`));
      };
      if (err) return fail(`${err}${u.searchParams.get('error_description') ? `: ${u.searchParams.get('error_description')}` : ''}`);
      if (u.searchParams.get('state') !== state) return fail('state mismatch');
      const code = u.searchParams.get('code');
      if (!code) return fail('no authorization code returned');
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Signed in', 'You can close this tab and return to the editor.'));
      clearTimeout(timer);
      resolve(code);
    });
  });
  // Don't leave an unhandled rejection if openUrl throws first.
  codePromise.catch(() => undefined);

  try {
    const auth = new URL(md.authorization_endpoint);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', opts.clientId);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('code_challenge', challenge);
    auth.searchParams.set('code_challenge_method', 'S256');
    auth.searchParams.set('state', state);
    if (opts.scope && opts.scope.trim()) auth.searchParams.set('scope', opts.scope.trim());
    await opts.openUrl(auth.toString());

    const code = await codePromise;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: opts.clientId,
      code_verifier: verifier,
    });
    let res: Response;
    try {
      res = await f(md.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });
    } catch (e) {
      throw new AcpError('unreachable', `Cannot reach the token endpoint ${md.token_endpoint}: ${(e as Error).message}`);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof json.access_token !== 'string') {
      throw new AcpError('auth', `Token exchange failed (HTTP ${res.status}${json.error ? `: ${json.error}` : ''}).`);
    }
    return {
      accessToken: json.access_token,
      tokenType: json.token_type,
      refreshToken: json.refresh_token,
      expiresAt: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : undefined,
    };
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}
