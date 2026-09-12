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
