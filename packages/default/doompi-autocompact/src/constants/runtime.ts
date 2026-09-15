export const ROOT_WORKING_LEAF = '@root';
export const PLAN_DOCUMENT_ENTRY = 'agent-harness-plan-document';
export const FOOTER_SOURCE = 'doom-autocompact';
export const FOOTER_ORDER = 20;
export const STATUS_KEY = 'doom-autocompact';
export const STATE_PHASE = {
  waiting: 'waiting',
  checkpointPending: 'checkpoint_pending',
  checkpointReady: 'checkpoint_ready',
  compacting: 'compacting',
} as const;

/**
 * Above this, the context hook is worth a telemetry event. Below it the hook is
 * noise against a round trip measured in seconds, and it runs on every request.
 */
export const SLOW_CONTEXT_HOOK_MS = 25;
