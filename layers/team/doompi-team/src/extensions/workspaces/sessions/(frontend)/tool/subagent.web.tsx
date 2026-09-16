import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { SubagentToolMessage } from './_components/SubagentToolMessage';

/** The subagent tool's timeline card. The filename names the tool it renders. */
export default defineToolRenderer({ message: SubagentToolMessage });
