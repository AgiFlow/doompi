import { defineChannel } from '@agimon-ai/doompi-core/extension-file';

import { createSubagentCatalogChannel } from '../../../controllers/webSubagentCatalogChannel';

/** The agent catalog, at every scope, for the same reason as the run graph. */
export default defineChannel(createSubagentCatalogChannel);
