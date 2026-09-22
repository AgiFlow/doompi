import { defineCliTool, type WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import { definePiTool, type PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { askUserToolRender } from '../../../../../tui/askUserToolRender';
import type { UserFeedbackPiScope } from '../_lib/root.cli';
import { createAskUserQuestionTool } from '../_tools/askUserQuestion';

export default defineCliTool((context: WithRoot<PiPluginContext, UserFeedbackPiScope>) =>
  definePiTool(createAskUserQuestionTool(context.context, context.root.toolDependencies, askUserToolRender)),
);
