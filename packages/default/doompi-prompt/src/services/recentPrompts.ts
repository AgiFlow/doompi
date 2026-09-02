import type { RecentPrompts } from '../types/prompt.ts';

/**
 * The staged prompt ring.
 *
 * DESIGN PATTERNS:
 * - Session-scoped and in memory. Nothing here touches the filesystem, so a
 *   prompt the user never explicitly saved is never written anywhere.
 * - Mirrors pi-tui's own history rules (trim, drop empty, skip a consecutive
 *   duplicate) so the picker and arrow up/down agree on what counts as an entry.
 *
 * AVOID:
 * - Growing the ring: three entries is the contract, not a default.
 */

/** How many prompts stay staged for quick reuse. */
export const RECENT_PROMPT_LIMIT = 3;

export function createRecentPrompts(limit: number = RECENT_PROMPT_LIMIT): RecentPrompts {
  let entries: string[] = [];

  return {
    push(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (entries[0] === trimmed) return;
      entries = [trimmed, ...entries].slice(0, limit);
    },
    list(): readonly string[] {
      return entries;
    },
  };
}
