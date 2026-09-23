import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { TeamPiScope } from '../../_lib/root.cli';

export default (context: WithRoot<PiPluginContext, TeamPiScope>) =>
  (event: Parameters<TeamPiScope['sessionStart']>[0], execution: ExtensionContext) =>
    context.root.sessionStart(event, execution);
