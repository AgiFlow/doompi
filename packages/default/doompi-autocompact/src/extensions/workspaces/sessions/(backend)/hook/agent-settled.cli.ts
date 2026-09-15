import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { AutocompactScope } from '../root.cli';

export default (context: WithRoot<PiPluginContext, AutocompactScope>) => context.root.events.agent_settled;
