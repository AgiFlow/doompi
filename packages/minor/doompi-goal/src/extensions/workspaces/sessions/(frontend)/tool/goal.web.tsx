import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { GoalToolMessage } from './_components/GoalToolMessage';
import { GOAL_TOOL_NAMES } from './_lib/goalToolRender';

export default defineToolRenderer({ tools: [...GOAL_TOOL_NAMES], message: GoalToolMessage });
