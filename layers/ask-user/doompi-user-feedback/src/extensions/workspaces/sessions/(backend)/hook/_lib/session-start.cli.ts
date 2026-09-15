import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { UserFeedbackPiScope } from '../../_lib/root.cli';

export default (context: WithRoot<PiPluginContext, UserFeedbackPiScope>) => context.root.sessionStart;
