import { defineRoute, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';

import type { McpServerScope } from '../../_lib/serverRoot';

/** Mounts the session's `mcp-session` API: the reachable tool detail the context panel opens. */
export default defineRoute((context: WithRoot<unknown, McpServerScope>) => context.root.api[0]!);
