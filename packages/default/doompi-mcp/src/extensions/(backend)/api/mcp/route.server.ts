import { defineRoute } from '@agimon-ai/doompi-core/extensionFile';

import { mcpHubApi } from '../../../../services/mcpHubApi';

/**
 * Mounts this package's HTTP API at `mcp`, which the folder names.
 *
 * The folder is the declaration: the build reads the base path off it and hands
 * the browser a client bound to the same segment, so the settings panel can no
 * longer spell a workspace mount by hand.
 */
export default defineRoute(mcpHubApi);
