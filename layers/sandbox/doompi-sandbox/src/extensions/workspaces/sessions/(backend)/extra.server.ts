import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { createSandboxServerRuntime } from '../../../../controllers/serverRuntime';

export default ({ agent }: DoomServerPluginContext) =>
  agent ? createSandboxServerRuntime(agent.context.environment) : {};
