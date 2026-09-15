import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';
import type { AutoStopPiScope } from '../root.cli';
export default (context: WithRoot<PiPluginContext, AutoStopPiScope>) => (_event: unknown, execution: Parameters<AutoStopPiScope['settled']>[0]) => context.root.settled(execution);
