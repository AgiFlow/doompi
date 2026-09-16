/**
 * How much of the model's window a conversation currently occupies.
 *
 * Occupancy is the last assistant turn's non-output tokens: input plus both
 * cache halves. Output tokens are already counted inside the next request's
 * input, so adding them would report the tail of the conversation twice.
 *
 * Two callers need this number and they reach it differently. The cockpit reads
 * the branch on demand; the Pi extension bridge tracks it from the message the
 * harness just finished. Both have to agree on what "context tokens" means, so
 * the definition lives here rather than at either call site.
 */
import type { Entry } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';

export interface ContextUsage {
  /** Null while unknown: no assistant message has been measured against the current context yet. */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export function contextTokensOf(usage: Usage | undefined): number | null {
  return usage === undefined ? null : usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Undefined when the active model declares no window, the one case where no ratio exists. */
export function contextUsageOf(tokens: number | null, contextWindow: number | undefined): ContextUsage | undefined {
  if (contextWindow === undefined) return undefined;
  return {
    tokens,
    contextWindow,
    percent: tokens === null ? null : Math.round((tokens / contextWindow) * 100),
  };
}

/** The newest assistant usage on a branch, for priming a live counter from persisted history. */
export function latestAssistantUsage(entries: readonly Entry[]): Usage | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'message' || entry.message.role !== 'assistant') continue;
    return entry.message.usage;
  }
  return undefined;
}
