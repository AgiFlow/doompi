export const STATE_CUSTOM_TYPE = 'doom-autocompact-state';
export const CHECKPOINT_MESSAGE_TYPE = 'doom-autocompact-checkpoint';
export const CONTEXT_MESSAGE_TYPE = 'doom-autocompact-context';
export const RESUME_MESSAGE_TYPE = 'doom-autocompact-resume';
export const RUNTIME_STATE_MESSAGE_TYPE = 'doom-autocompact-runtime-state';
export const STATE_VERSION = 2;
/** Retrying a malformed checkpoint costs a full summarization call per turn, so a pass that
 *  keeps failing is abandoned instead of retried for the rest of the session. */
export const MAX_INVALID_CHECKPOINT_ATTEMPTS = 3;

export const COMPACTION_THRESHOLDS = {
  1: { ratio: 0.5, capTokens: 200_000 },
  2: { ratio: 0.75, capTokens: 500_000 },
  3: { ratio: 0.95, capTokens: 800_000 },
} as const;

export const CHECKPOINT_HEADINGS = [
  '## Goal',
  '## Constraints & Preferences',
  '## Progress',
  '### Done',
  '### In Progress',
  '### Blocked',
  '## Key Decisions',
  '## Next Steps',
  '## Critical Context',
] as const;
