import type { HookDocumentSource, ParsedRegistrySource, RegistryEntry, ResolvedHook } from '../types/hooks.ts';
import { matchesTool } from './toolNames.ts';

/** Which rows a dispatch keeps, once the session's selection is known. */
export interface RegistrySelection {
  event: string;
  toolName?: string;
  /** Selected group ids, or undefined for "every group", the standalone default. */
  allowedGroups?: readonly string[];
  inSubagent: boolean;
}

/**
 * Identity of a set of registry sources, for callers that cache the parse.
 *
 * Keyed on contents rather than mtime, so it stays correct for an in-place
 * rewrite and needs no invalidation hook. Reading both files is cheap; parsing
 * is what a cache built on this skips.
 */
export function registryCacheKey(sources: ReadonlyArray<HookDocumentSource>): string {
  return sources.map((source) => `${source.baseDirectory} ${source.text}`).join(' ');
}

/**
 * Flattens parsed registry documents into sorted rows, keeping only bindings
 * that declare a `pi` frontend.
 *
 * A later source replaces the group of the same id outright rather than merging
 * into it, so a repository that redefines a group owns it completely.
 */
export function registryEntries(sources: ReadonlyArray<ParsedRegistrySource>): RegistryEntry[] {
  const groups = new Map<string, RegistryEntry[]>();
  let position = 0;
  for (const source of sources) {
    for (const [groupId, group] of Object.entries(source.document.groups ?? {})) {
      const entries: RegistryEntry[] = [];
      for (const hook of group.hooks ?? []) {
        // Every declared hook advances the position, whether or not it is kept,
        // so the sort tiebreaker stays the order the file declares them in.
        position += 1;
        if (!hook.pi) continue;
        entries.push({
          ...hook.pi,
          event: hook.event,
          order: hook.pi.order ?? 0,
          position,
          groupId,
          core: group.core === true,
          baseDirectory: source.baseDirectory,
        });
      }
      groups.set(groupId, entries);
    }
  }

  const entries = [...groups.values()].flat();
  entries.sort((left, right) => left.order - right.order || left.position - right.position);
  return entries;
}

/**
 * The rows one dispatch runs.
 *
 * Group selection changes when /mode switches mid-session, so inclusion is
 * applied per call rather than being baked into a cached parse. Core groups
 * always load; the rest are gated by the layers the harness resolved.
 */
export function selectRegistryHooks(
  entries: ReadonlyArray<RegistryEntry>,
  selection: RegistrySelection,
): ResolvedHook[] {
  const allowed = selection.allowedGroups === undefined ? undefined : new Set(selection.allowedGroups);
  return entries
    .filter((entry) => entry.core || !allowed || allowed.has(entry.groupId))
    .filter((entry) => entry.event === selection.event)
    .filter((entry) => !(entry.skipInSubagent && selection.inSubagent))
    .filter((entry) => matchesTool(entry.matcher, selection.toolName))
    .map((entry) => ({
      hook: { command: entry.command, timeout: entry.timeout },
      // The declaring config's root, so a global hook can reach its own scripts
      // through CLAUDE_PLUGIN_ROOT while still running against this repository.
      root: entry.baseDirectory,
    }));
}
