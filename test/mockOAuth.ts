import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';

export interface MockOAuthOptions {
  /** Publish RFC 9728 metadata on the "resource" origin (default true). */
  protectedResource?: boolean;
  /** Which path the AS metadata is served at; default the root issuer. */
  issuerPath?: string;
  /** Token the server issues. */
  accessToken?: string;
  /** Make /authorize redirect back with a wrong state. */
  wrongState?: boolean;
  /** Make /authorize redirect back with error=access_denied. */
  deny?: boolean;
}

/** One HTTP server that is both the protected resource (for discovery) and the authorization server. */
export class MockOAuth {
  private server = http.createServer((req, res) => this.handle(req, res));
  authorizeRequests: URL[] = [];
  tokenRequests: URLSearchParams[] = [];
  private codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  accessToken: string;

  constructor(private readonly opts: MockOAuthOptions = {}) {
    this.accessToken = opts.accessToken ?? 'oauth-access-token-xyz';
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  get issuer(): string {
    return this.origin + (this.opts.issuerPath ?? '');
  }
  /** What the agent's ws URL would be (same origin as the resource metadata). */
  get wsUrl(): string {
    return this.origin.replace('http', 'ws') + '/acp';
  }

  /** The "browser": follow /authorize and hit the loopback redirect. */
  async browser(authorizeUrl: string): Promise<void> {
    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    const loc = res.headers.get('location');
    if (!loc) throw new Error(`authorize did not redirect (${res.status})`);
    await fetch(loc);
  }

  private json(res: http.ServerResponse, body: unknown, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? '/', this.origin);
    const asMeta = `/.well-known/oauth-authorization-server${this.opts.issuerPath ?? ''}`;
    if (u.pathname === '/.well-known/oauth-protected-resource') {
      if (this.opts.protectedResource === false) return void res.writeHead(404).end();
      return this.json(res, { resource: this.origin, authorization_servers: [this.issuer] });
    }
    if (u.pathname === asMeta) {
      return this.json(res, {
        issuer: this.issuer,
        authorization_endpoint: `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (u.pathname === '/authorize') {
      this.authorizeRequests.push(u);
      const redirect = new URL(u.searchParams.get('redirect_uri')!);
      if (this.opts.deny) {
        redirect.searchParams.set('error', 'access_denied');
      } else {
        const code = crypto.randomBytes(8).toString('hex');
        this.codes.set(code, {
          challenge: u.searchParams.get('code_challenge')!,
          redirectUri: u.searchParams.get('redirect_uri')!,
          clientId: u.searchParams.get('client_id')!,
        });
        redirect.searchParams.set('code', code);
      }
      redirect.searchParams.set('state', this.opts.wrongState ? 'attacker-state' : u.searchParams.get('state')!);
      return void res.writeHead(302, { Location: redirect.toString() }).end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        this.tokenRequests.push(p);
        const rec = this.codes.get(p.get('code') ?? '');
        if (!rec || p.get('grant_type') !== 'authorization_code') return this.json(res, { error: 'invalid_grant' }, 400);
        const challenge = crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (challenge !== rec.challenge || p.get('redirect_uri') !== rec.redirectUri || p.get('client_id') !== rec.clientId) {
          return this.json(res, { error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
        }
        this.codes.delete(p.get('code')!);
        return this.json(res, { access_token: this.accessToken, token_type: 'Bearer', expires_in: 2592000 });
      });
      return;
    }
    res.writeHead(404).end();
  }
}
