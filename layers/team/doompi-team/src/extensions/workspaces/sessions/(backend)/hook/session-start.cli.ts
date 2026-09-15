import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { TeamPiScope } from '../root.cli';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) =>
  (event: Parameters<TeamPiScope['sessionStart']>[0], execution: ExtensionContext) =>
    context.root.sessionStart(event, execution);
