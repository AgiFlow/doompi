import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { api } from '../../controllers/hubApi';
import { createWorktreesChannel } from '../../controllers/worktreesChannel';

export default ({ host }: DoomServerPluginContext) =>
  host.scope === 'session' ? {} : { channels: [createWorktreesChannel], api: [api] };
