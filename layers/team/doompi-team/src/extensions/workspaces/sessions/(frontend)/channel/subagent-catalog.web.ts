import { defineChannelFile } from '@agimon-ai/doompi-core/web';

import { subagentCatalogChannel } from '../_lib/catalogStore';

/** The agent catalog the session facet publishes. The filename is the frame type. */
export default defineChannelFile(subagentCatalogChannel);
