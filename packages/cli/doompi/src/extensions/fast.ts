import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const FAST_ENTRY = 'doompi.fast-mode';
const CODEX_PROVIDER = 'openai-codex';
const CODEX_API = 'openai-codex-responses';

/** Project Fast intent from the current session's branch, independent of its model. */
export function readSessionFastMode(sessionManager: ExtensionContext['sessionManager']): boolean {
  let enabled = false;
  const sessionId = sessionManager.getSessionId();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== FAST_ENTRY) continue;
    const data = entry.data as { enabled?: unknown; sessionId?: unknown } | undefined;
    if (data?.sessionId === sessionId) enabled = data.enabled === true;
  }
  return enabled;
}

export function fastExtension(pi: ExtensionAPI): void {
  let enabled = false;
  const restore = (_args: string, ctx: ExtensionContext): void => {
    enabled = readSessionFastMode(ctx.sessionManager);
  };
  pi.on('session_start', (_event, ctx) => restore('', ctx));
  pi.on('session_tree', (_event, ctx) => restore('', ctx));
  pi.on('before_provider_request', (event, ctx) => {
    if (!enabled || ctx.model?.provider !== CODEX_PROVIDER || ctx.model.api !== CODEX_API) return;
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
      throw new Error('Invalid Codex provider payload');
    // This hook receives the HTTP body, after Pi maps the serviceTier option.
    return { ...event.payload, service_tier: 'priority' };
  });
  pi.registerCommand('fast', {
    description: 'Opt this session into Codex priority service (may increase cost)',
    getArgumentCompletions: (prefix) =>
      ['on', 'off'].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value !== 'on' && value !== 'off') {
        ctx.ui.notify('Usage: /fast on|off', 'warning');
        return;
      }
      if (value === 'on' && (ctx.model?.provider !== CODEX_PROVIDER || ctx.model.api !== CODEX_API))
        throw new Error('Fast mode requires an openai-codex model');
      const requested = value === 'on';
      pi.appendEntry(FAST_ENTRY, { version: 1, sessionId: ctx.sessionManager.getSessionId(), enabled: requested });
      enabled = requested;
      ctx.ui.notify(`Fast mode ${value} for this session.`, 'info');
    },
  });
}

export default fastExtension;
