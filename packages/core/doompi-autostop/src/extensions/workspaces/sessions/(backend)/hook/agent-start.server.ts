import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
import type { AutoStopServerScope } from '../root.server';
export default (context: WithRoot<DoomServerPluginContext, AutoStopServerScope>) => context.root.hooks.find((hook) => hook.event === 'agent_start')!;
