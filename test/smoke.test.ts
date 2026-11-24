import { describe, expect, it } from 'vitest';
import { AcpClient } from '../src/core/client';
import { AcpError } from '../src/core/errors';
import { CLIENT_INFO, ScriptedPermissions, services } from './helpers';

// Real-server smoke test. $AGENT_SWARM_RUN_TOKEN is a *run* token, which the live
// endpoint refuses to drive an ACP session, so the point is that the refusal
// reaches the user as a clean, typed error. The token is never printed.
const token = process.env.AGENT_SWARM_RUN_TOKEN;
const url = process.env.ACP_SMOKE_URL ?? 'wss://agent-swarm.f-proj.com/acp';

describe.skipIf(!token)('real server smoke test', () => {
  it('a run token is refused and surfaced as a forbidden error', async () => {
    const err = await AcpClient.connect({
      url,
      headers: { Authorization: `Bearer ${token}` },
      services: services(new ScriptedPermissions()),
      clientInfo: CLIENT_INFO,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AcpError);
    // The server refuses with HTTP 403 at the upgrade (or close code 4403 behind a proxy
    // that completes the upgrade first). Either way: "forbidden", with a readable message.
    expect(err.kind).toBe('forbidden');
    expect(err.message).toMatch(/403/);
    expect(err.message).not.toContain(token as string);
    expect(err.needsReauth).toBe(true);
    console.log(`smoke: ${err.kind} — ${err.message}`);
  }, 30_000);
});
