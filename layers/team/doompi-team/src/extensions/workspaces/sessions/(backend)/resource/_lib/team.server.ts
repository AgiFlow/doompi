import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import type { TeamServerScope } from '../../_lib/root.server';

export default (context: WithRoot<DoomServerPluginContext, TeamServerScope>) => ({
  name: 'doompi/team',
  kind: 'context' as const,
  read: () =>
    JSON.stringify(
      {
        sessionId: context.root.execution.sessionId,
        members: context.root.channel.current() ? [context.root.channel.current()] : [],
      },
      null,
      2,
    ),
});
