export const PACKAGE_SOURCE = '@agimon-ai/doompi-mcp';
/** Leader binding ids are restricted to `[a-z0-9][a-z0-9._:-]*`, so the scope and slash are dropped. */
export const LEADER_BINDING_PREFIX = 'doom-mcp';
/**
 * Sits under the existing `extension` group, beside `tools` and `config`.
 *
 * A top-level key would have to be unique across every extension, and MCP belongs
 * next to the tool browser a user reaches for anyway. `t` in particular is taken:
 * it is Doom Task's top-level group.
 */
export const LEADER_GROUP = { key: 'e', label: 'extension', detail: 'tools, skills and config', order: 50 } as const;
export const LEADER_KEY = 'm';
export const LEADER_LABEL = 'mcp';
export const LEADER_DETAIL = 'servers and tools';
