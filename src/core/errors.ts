/** Error classes shared by the whole ACP client core. No `vscode` imports here. */

export type AcpErrorKind =
  | 'auth' // 4401 / HTTP 401: credentials missing, wrong or expired
  | 'forbidden' // 4403 / HTTP 403: refused (wrong token, or valid but not allowed)
  | 'unreachable' // DNS / TCP / TLS failure, handshake timeout
  | 'dropped' // the socket closed while we still needed it
  | 'protocol' // unexpected server behaviour
  | 'config'; // user settings are incomplete

export class AcpError extends Error {
  constructor(
    readonly kind: AcpErrorKind,
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'AcpError';
  }

  /** Errors the user fixes by signing in again / replacing the token. */
  get needsReauth(): boolean {
    return this.kind === 'auth' || this.kind === 'forbidden';
  }
}

/** A JSON-RPC error object received from (or sent to) the peer. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RESOURCE_NOT_FOUND: -32002,
} as const;

export const CLOSE_AUTH = 4401;
export const CLOSE_FORBIDDEN = 4403;

/** Map a WebSocket close code (after the socket was open) to an error. */
export function errorForClose(code: number, reason: string, host: string): AcpError {
  if (code === CLOSE_AUTH) {
    return new AcpError(
      'auth',
      `${host} rejected the credentials (close code 4401${reason ? `: ${reason}` : ''}). Sign in again or set a new token.`,
      code,
    );
  }
  if (code === CLOSE_FORBIDDEN) {
    return new AcpError(
      'forbidden',
      `${host} refused access (close code 4403${reason ? `: ${reason}` : ''}). The credential was understood but is not allowed to use this agent.`,
      code,
    );
  }
  return new AcpError(
    'dropped',
    `The connection to ${host} was lost (close code ${code}${reason ? `: ${reason}` : ''}).`,
    code,
  );
}

/** Map an HTTP status seen during the WebSocket upgrade to an error. */
export function errorForHandshake(status: number, host: string): AcpError {
  if (status === 401) {
    return new AcpError(
      'auth',
      `${host} rejected the credentials (HTTP 401). Sign in again or set a new token.`,
      status,
    );
  }
  if (status === 403) {
    return new AcpError(
      'forbidden',
      `${host} refused the connection (HTTP 403). The token is wrong, expired, or not allowed to use this agent.`,
      status,
    );
  }
  return new AcpError('protocol', `${host} answered the WebSocket upgrade with HTTP ${status} instead of 101.`, status);
}

/** Map a Node network error to a user-facing "unreachable" error. */
export function errorForNetwork(err: unknown, host: string): AcpError {
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ? ` (${e.code})` : '';
  const msg = e?.message ?? String(err);
  return new AcpError('unreachable', `Cannot reach ${host}${code}: ${msg}`);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
