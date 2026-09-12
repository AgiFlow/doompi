import type { DoomToolRestriction } from '@agimon-ai/doompi-core/tool-surface';
import type { McpCatalog } from '../mcpCatalog';
/**
 * Hides every wrapper this extension owns that the catalog does not currently offer.
 *
 * The surface recomputes from the whole registered inventory, so this only ever
 * removes: a server that reconnected is already in `incoming` and nothing has to
 * put it back. Historical ownership matters after reconfiguration because Pi
 * cannot unregister a wrapper the new domain no longer selects.
 *
 * The visible set is read once, here, so the returned function stays pure and a
 * later re-apply by another owner cannot see half a catalog change.
 */
export function mcpToolRestriction(
  catalog: McpCatalog,
  historicallyOwnedNames: ReadonlySet<string> = new Set(catalog.allTools().map((tool) => tool.piName)),
  incompatibleNames: ReadonlySet<string> = new Set(),
): DoomToolRestriction {
  const visible = new Set(catalog.activeToolNames().filter((name) => !incompatibleNames.has(name)));
  return (incoming) => incoming.filter((name) => !historicallyOwnedNames.has(name) || visible.has(name));
}
