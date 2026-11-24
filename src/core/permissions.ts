export type PermissionDecision = 'allow' | 'allow_always' | 'reject';

export interface PermissionRequest {
  toolCallId?: string;
  kind: string;
  title: string;
  rawInput?: unknown;
}

/** What the IDE adapter provides for asking the user. Resolve `undefined` if dismissed. */
export interface PermissionHost {
  ask(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision | undefined>;
}

interface Option {
  optionId: string;
  name?: string;
  kind?: string;
}

export function pickOption(options: Option[], wanted: PermissionDecision): Option | undefined {
  const kinds: Record<PermissionDecision, string[]> = {
    allow: ['allow_once', 'allow_always'],
    allow_always: ['allow_always', 'allow_once'],
    reject: ['reject_once', 'reject_always'],
  };
  for (const k of kinds[wanted]) {
    const o = options.find((x) => x.kind === k);
    if (o) return o;
  }
  return undefined;
}

type Outcome = { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } };

/**
 * Serves `session/request_permission` and remembers "always allow" per tool kind.
 * The memory lives as long as the chat (one instance per session).
 */
export class PermissionPolicy {
  private readonly always = new Set<string>();
  constructor(
    private readonly host: PermissionHost,
    private readonly autoAllow: () => boolean,
  ) {}

  reset(): void {
    this.always.clear();
  }

  async handle(params: any, signal: AbortSignal): Promise<Outcome> {
    const options: Option[] = Array.isArray(params?.options) ? params.options : [];
    const tc = params?.toolCall ?? {};
    const kind = String(tc.kind ?? 'other');
    const select = (d: PermissionDecision): Outcome => {
      const o = pickOption(options, d);
      if (!o) return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: o.optionId } };
    };
    if (this.autoAllow() || this.always.has(kind)) return select('allow');
    if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
    // Race the UI against cancel: a notification the user never answers must not wedge the turn.
    const aborted = new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
    const decision = await Promise.race([
      this.host.ask({ toolCallId: tc.toolCallId, kind, title: String(tc.title ?? kind), rawInput: tc.rawInput }, signal),
      aborted,
    ]);
    if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
    if (decision === undefined) return select('reject'); // dismissed = not allowed
    if (decision === 'allow_always') this.always.add(kind);
    return select(decision);
  }
}
