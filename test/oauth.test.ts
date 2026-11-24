import { afterEach, describe, expect, it } from 'vitest';
import { AcpClient } from '../src/core/client';
import { AcpError } from '../src/core/errors';
import { discover, makePkce, signIn } from '../src/core/oauth';
import { MockAgent } from './mockAgent';
import { MockOAuth } from './mockOAuth';
import { CLIENT_INFO, ScriptedPermissions, services } from './helpers';
import * as crypto from 'crypto';

let oauth: MockOAuth | undefined;
afterEach(async () => {
  await oauth?.stop();
  oauth = undefined;
});

const start = async (o = {}) => {
  oauth = new MockOAuth(o);
  await oauth.start();
  return oauth;
};

describe('OAuth 2.0 authorization code + PKCE (mock authorization server)', () => {
  it('discovers via RFC 9728, signs in with S256 on a 127.0.0.1 loopback, and the token works on the agent', async () => {
    const o = await start();
    const result = await signIn({
      endpointUrl: o.wsUrl,
      clientId: 'vscode-acp-plugin',
      scope: 'acp',
      openUrl: (url) => o.browser(url),
    });
    expect(result.accessToken).toBe('oauth-access-token-xyz');
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    const a = o.authorizeRequests[0];
    expect(a.searchParams.get('response_type')).toBe('code');
    expect(a.searchParams.get('client_id')).toBe('vscode-acp-plugin');
    expect(a.searchParams.get('code_challenge_method')).toBe('S256');
    expect(a.searchParams.get('scope')).toBe('acp');
    expect(a.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // The verifier sent to /token hashes to the challenge sent to /authorize.
    const t = o.tokenRequests[0];
    expect(t.get('grant_type')).toBe('authorization_code');
    expect(crypto.createHash('sha256').update(t.get('code_verifier')!).digest('base64url')).toBe(a.searchParams.get('code_challenge'));
    expect(t.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);

    // The resulting token is accepted by an agent that checks the Authorization header.
    const agent = await MockAgent.start({ token: result.accessToken });
    try {
      const client = await AcpClient.connect({
        url: agent.url,
        headers: { Authorization: `Bearer ${result.accessToken}` },
        services: services(new ScriptedPermissions()),
        clientInfo: CLIENT_INFO,
      });
      expect(client.agentInfo.name).toBe('mock-agent');
      client.close();
    } finally {
      await agent.stop();
    }
  });

  it('falls back to the configured issuer (RFC 8414, path-aware) when there is no protected-resource metadata', async () => {
    const o = await start({ protectedResource: false, issuerPath: '/tenant1' });
    await expect(discover({ endpointUrl: o.wsUrl })).rejects.toThrow(/acp\.oauth\.issuer/);
    const md = await discover({ endpointUrl: o.wsUrl, issuer: o.issuer });
    expect(md.token_endpoint).toBe(`${o.origin}/token`);
  });

  it('rejects a callback with a mismatching state', async () => {
    const o = await start({ wrongState: true });
    const err = await signIn({ endpointUrl: o.wsUrl, clientId: 'c', openUrl: (u) => o.browser(u) }).catch((e) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect(err.message).toMatch(/state mismatch/);
    expect(o.tokenRequests).toHaveLength(0);
  });

  it('surfaces an access_denied error from the authorization server', async () => {
    const o = await start({ deny: true });
    const err = await signIn({ endpointUrl: o.wsUrl, clientId: 'c', openUrl: (u) => o.browser(u) }).catch((e) => e);
    expect(err.message).toMatch(/access_denied/);
  });

  it('times out if the browser never returns', async () => {
    const o = await start();
    const err = await signIn({ endpointUrl: o.wsUrl, clientId: 'c', openUrl: () => undefined, timeoutMs: 100 }).catch((e) => e);
    expect(err.message).toMatch(/timed out/);
  });

  it('PKCE verifier/challenge are RFC 7636 shaped', () => {
    const { verifier, challenge } = makePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  });
});
