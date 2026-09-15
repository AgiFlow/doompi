import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { ConfigPiScope } from '../root.cli';
export default (context: WithRoot<PiPluginContext, ConfigPiScope>) => context.root.onSessionStart;
