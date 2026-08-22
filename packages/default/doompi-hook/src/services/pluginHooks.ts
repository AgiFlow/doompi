import type { PluginHookDocument, ResolvedHook } from '../types/hooks.ts';
import { matchesTool } from './toolNames.ts';

/**
 * The plugin hooks one dispatch runs.
 *
 * Plugin configs are the Claude Code `hooks.json` shape verbatim: an event name
 * maps to groups, each with an optional matcher and a list of commands. Order
 * follows the declaration order of the plugins the harness resolved.
 */
export function selectPluginHooks(
  documents: ReadonlyArray<PluginHookDocument>,
  eventName: string,
  toolName?: string,
): ResolvedHook[] {
  const matches: ResolvedHook[] = [];
  for (const document of documents) {
    for (const group of document.config.hooks?.[eventName] ?? []) {
      if (!matchesTool(group.matcher, toolName)) continue;
      for (const hook of group.hooks ?? []) matches.push({ hook, root: document.pluginRoot });
    }
  }
  return matches;
}
