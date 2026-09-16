import { defineRoute } from '@agimon-ai/doompi-core/extension-file';

import { api } from '../../../../../../services/runnerLogApi';

/**
 * Mounts this package's HTTP API at `runner`, which the folder names.
 *
 * The folder is the declaration: the build reads the base path off it and hands
 * the browser a client bound to the same segment, so the mount is stated once
 * rather than in a constant and in four URL builders that were each free to
 * drift.
 */
export default defineRoute(api);
