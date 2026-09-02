/** Values shared by this package's Pi-facing adapters. */

export const PACKAGE_SOURCE = '@agimon-ai/doompi-prompt';
export const LEADER_BINDING_PREFIX = 'doom-prompt';
/**
 * The shared extension group other packages already contribute to. Key, label
 * and order have to match theirs or the leader panel shows two `e` groups.
 */
export const LEADER_GROUP = { key: 'e', label: 'extension', detail: 'tools, skills and config', order: 50 } as const;
export const LEADER_KEY = 'p';
export const LEADER_LABEL = 'prompts';
export const LEADER_DETAIL = 'staged and saved prompts';
