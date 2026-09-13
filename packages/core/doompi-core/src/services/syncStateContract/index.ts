/**
 * Bumped whenever the persisted sync-state shape changes.
 *
 * Version 13 carries the immutable MCP projection as file-only state. Older
 * records relied on process environment and cannot safely select MCP servers
 * after an in-process reload.
 */
export const SYNC_STATE_VERSION = 13;

/** Version 5 maps each composition fingerprint directly to its compiler manifest. */
export const PRECOMPILE_STATE_VERSION = 5;

export const BUNDLED_PRECOMPILE_STRATEGY = 'bundle';
