import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { GoalToolMessage } from '../../../../../web/components/GoalToolMessage';
import { GOAL_TOOL_NAMES } from '../../../../../web/lib/goalToolRender';

export default defineToolRenderer({ tools: [...GOAL_TOOL_NAMES], message: GoalToolMessage });
