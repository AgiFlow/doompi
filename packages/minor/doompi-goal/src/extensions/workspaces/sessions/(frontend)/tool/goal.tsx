import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';

import { GoalToolMessage } from '../../../../../web/components/GoalToolMessage';
import { GOAL_TOOL_NAMES } from '../../../../../web/lib/goalToolRender';

export default defineRoutedContribution({ tools: [...GOAL_TOOL_NAMES], message: GoalToolMessage }, {});
