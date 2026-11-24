# ACP Remote Agent Client for VS Code

A **generic [ACP](https://agentclientprotocol.com) (Agent Client Protocol) client** for a **remote agent reachable over a WebSocket**. You chat in the editor. The agent owns the model and the conversation. Every command and file operation it asks for is executed **locally, by the extension, in your open workspace**, never on the server.

- Plain ACP (JSON-RPC 2.0) only. No agent-specific code paths: the endpoint URL and the credentials are settings, so any ACP agent that speaks WebSocket works. [agent-swarm](https://github.com/vasyaod/agent-swarm) is simply the first one it was built for.
- Works in VS Code and in Cursor (and other VS Code forks): the chat is a plain webview in its own activity-bar container, and the extension uses no proposed APIs.
- No telemetry. The only network traffic is to the agent URL you configure (and the OAuth server, if you use browser sign-in).

## Install (from the GitHub release)

1. Download `vscode-acp-plugin-<version>.vsix` from the [latest release](https://github.com/vasyaod/vscode-acp-plugin/releases/latest).
2. VS Code or Cursor: **Extensions** view → `⋯` menu → **Install from VSIX…** → pick the file. (CLI: `code --install-extension vscode-acp-plugin-0.1.0.vsix`, or `cursor --install-extension …`.)
3. Open a **folder** (the agent works in the workspace root; with several folders the first one is used).
4. Click the **ACP Agent** icon in the activity bar.

The extension is not on the Marketplace or Open VSX yet.

## Configure

Open Settings and search for `acp`.

| Setting | Meaning |
|---|---|
| `acp.url` | WebSocket URL of the agent, e.g. `wss://agent.example.com/acp` (`ws://` works for local agents). |
| `acp.authMode` | `token` (default), `oauth`, or `none`. |
| `acp.extraHeaders` | Extra headers for the WebSocket upgrade, e.g. `{"X-Org": "acme"}`. Not for secrets. |
| `acp.oauth.issuer` | OAuth issuer URL, used only when the agent publishes no protected-resource metadata. |
| `acp.oauth.clientId` | OAuth public client id. Default `vscode-acp-plugin`. |
| `acp.oauth.scope` | Optional OAuth scope. |
| `acp.autoAllow` | Approve every permission request without asking. **Dangerous**, off by default. |
| `acp.showThoughts` | Show the agent's thought chunks in the chat. |

### Auth mode: Token

Run **ACP: Set Token** from the command palette and paste the bearer token. It is kept in the editor's **secret store** (not in settings, not in the settings sync) and sent as `Authorization: Bearer <token>` in the WebSocket upgrade. **ACP: Sign Out** removes it.

### Auth mode: Sign in with browser

Standard OAuth 2.0 authorization code + **PKCE (S256)**, public client, loopback redirect `http://127.0.0.1:<random port>/callback`. Run **ACP: Sign In**; your browser opens, you approve, and the access token goes to the secret store.

The authorization server is discovered generically:

1. [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) `/.well-known/oauth-protected-resource` on the agent URL's origin;
2. else the issuer you set in `acp.oauth.issuer`;
3. then [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) `/.well-known/oauth-authorization-server` metadata of that issuer.

`client_id` defaults to `vscode-acp-plugin` (the auth server must accept it, or register it and set `acp.oauth.clientId`). When the server answers close code `4401` or HTTP `401`, the chat offers **Sign in again**. In remote windows (SSH, WSL, Codespaces) the loopback redirect needs port forwarding; if the callback cannot reach the extension host, use token mode.

### Example: agent-swarm

```jsonc
// settings.json
{
  "acp.url": "wss://agent-swarm.f-proj.com/acp",
  "acp.authMode": "token"
}
```

Then **ACP: Set Token** with the swarm's operator token. (agent-swarm refuses run tokens on `/acp` and answers 403 / close code 4403; the chat tells you so. Browser sign-in against `https://auth.f-proj.com` needs a server-side change in agent-swarm first.)

### Pointing it at any other ACP agent

Anything that serves ACP over a WebSocket with `initialize`, `session/new` and `session/prompt` works. Set `acp.url`, pick the auth mode the server wants (`none` for an unauthenticated local agent), and, if it needs extra headers, add them in `acp.extraHeaders`. The extension advertises the `fs.readTextFile`, `fs.writeTextFile` and `terminal` client capabilities, so the agent can ask for them. `session/load` is not used: after a dropped connection the next prompt starts a **new session**.

## Using it

- Type a prompt, press **Enter**. The reply streams in; tool calls appear as cards (kind, title, status, output), expandable.
- **Stop** sends `session/cancel`. **New chat** (button or the `+` in the view title) opens a new `session/new`; within a chat, every prompt reuses the same session.
- **Permissions.** Before the agent runs a command or writes a file you get a native dialog: **Allow**, **Always allow** (remembered per tool kind until New chat) or **Reject** (closing the dialog also rejects).
- **What ran locally** is mirrored to the **ACP** output channel (`ACP: Show Output`): each command with its working directory, its live output and exit status, plus each file read/write.
- **Copilot Chat:** if the chat API is available, `@acp` also works there, sharing the same session as the webview. The extension activates fine without Copilot.

### Local execution

| ACP request | Done by the extension |
|---|---|
| `terminal/create`, `output`, `wait_for_exit`, `kill`, `release` | child process in the workspace root; output bounded by `outputByteLimit` (oldest bytes dropped on a UTF-8 boundary) |
| `fs/read_text_file` | the **open editor's text** (unsaved edits included) if the file is open, else the disk; honours `line` / `limit` |
| `fs/write_text_file` | a minimal `WorkspaceEdit` on the document (so **undo works** and the editor stays in sync), then saved; new files via `workspace.fs` |
| `session/request_permission` | native Allow / Always allow / Reject |

## Errors you may see

| Message | Meaning |
|---|---|
| "rejected the credentials (4401 / HTTP 401)" | wrong, missing or expired credential: **Sign in again** / **ACP: Set Token** |
| "refused access (4403)" / "refused the connection (HTTP 403)" | the server understood the credential but won't let it drive an agent session (or doesn't accept it) |
| "Cannot reach host (ECONNREFUSED / ENOTFOUND …)" | wrong URL, offline, firewall |
| "The connection to host was lost" | the socket dropped, possibly mid-turn; the next prompt reconnects with a new session |

## Architecture

```
src/core/      no `vscode` imports: unit-tested against a mock agent
  connection.ts  JSON-RPC 2.0 over WebSocket (ws); close-code / handshake error mapping
  client.ts      initialize, session/new, session/prompt, session/cancel; serves the agent's requests
  fs.ts          fs/read_text_file, fs/write_text_file behind FsHost
  terminals.ts   terminal/* as local child processes behind TerminalObserver
  permissions.ts session/request_permission + per-kind "always" memory behind PermissionHost
  oauth.ts       discovery (RFC 9728 / 8414) + authorization code + PKCE loopback flow
  chat.ts        the chat model and connection lifecycle (reconnect, new chat)
src/           the thin VS Code layer
  vscodeHost.ts  FsHost (TextDocuments + WorkspaceEdit), PermissionHost (native dialog), OutputChannel
  settings.ts    settings + SecretStorage
  chatView.ts + media/chat.{js,css}   the webview;   participant.ts   optional @acp
test/          mock ACP agent + mock OAuth server (vitest), jsdom test of the webview,
               and test/integration (real VS Code via @vscode/test-electron)
```

## Develop

```bash
npm ci
npm test                   # headless: core vs mock agent, mock OAuth, webview in jsdom
npm run package            # dist/vscode-acp-plugin.vsix
xvfb-run -a npm run test:integration   # real VS Code (Linux needs a display)
```

`test/smoke.test.ts` runs only when `AGENT_SWARM_RUN_TOKEN` is set: it connects to the live agent-swarm endpoint, which refuses run tokens, and asserts the refusal surfaces as a clean "forbidden" error. The token is never printed.

A `v*` tag builds the `.vsix` and attaches it to a GitHub Release (see `.github/workflows/ci.yml`).

## Manual test checklist (for the owner)

Real VS Code **and** Cursor:

- [ ] Install the `.vsix`; the **ACP Agent** icon appears in the activity bar and the chat view opens.
- [ ] No URL set → sending shows "No agent URL set" with an **Open settings** button.
- [ ] Set `acp.url` to `wss://agent-swarm.f-proj.com/acp`, **ACP: Set Token** with a *wrong* token → "rejected the credentials" with a **Sign in again / set token** button that opens the token prompt.
- [ ] With a valid operator token: prompt `run hostname and pwd, read README.md`. A permission dialog appears; **Allow**.
  - [ ] The tool card shows **your machine's** hostname and the workspace path (compare with a local terminal), not the server's.
  - [ ] The **ACP** output channel shows the command, cwd, output and exit code.
  - [ ] The answer mentions the contents of your README.
- [ ] Edit README.md without saving, ask the agent to read it → it sees your unsaved text.
- [ ] Ask the agent to edit a file → the open editor updates, **Undo** (Ctrl/Cmd+Z) reverts it.
- [ ] Send a second prompt that refers to the first ("what was the directory again?") → same session, it remembers.
- [ ] Choose **Always allow** once; the next command of the same kind does not prompt. **New chat** → prompts again.
- [ ] Start a long prompt (e.g. `run sleep 60`) and press **Stop** → "Stopped."; the next prompt works.
- [ ] Kill the network / restart the server mid-turn → a "connection was lost" notice; the next prompt reconnects ("new session").
- [ ] (VS Code with Copilot Chat) `@acp hello` replies in the Chat view.
- [ ] Sign in with browser against a server that supports it: **ACP: Sign In** opens the browser, returns to the editor, and the chat connects.

## License

MIT
