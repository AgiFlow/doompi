import { defineChannelFile } from '@agimon-ai/doompi-core/web';

import { subagentRunsChannel } from '../_lib/subagentsStore';

/** The run graph the session facet publishes. The filename is the frame type. */
export default defineChannelFile(subagentRunsChannel);
