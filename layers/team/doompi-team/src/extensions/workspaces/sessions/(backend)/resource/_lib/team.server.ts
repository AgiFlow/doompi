import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { formatTeamContextSnapshot, readActiveTeamSnapshot } from '../../../../../../services/teamSnapshot';
import type { TeamServerScope } from '../../_lib/root.server';

/**
 * The roster the model is allowed to see.
 *
 * Reads the public snapshot rather than `channel.current()`: the latter is the raw
 * `TeamMemberContext`, whose `token` is a session capability documented as never
 * leaving the direct context. A context resource is pasted into the system prompt,
 * sent to the provider and persisted, so the raw struct must not be serialized here.
 * `formatTeamContextSnapshot` is the same projection the Pi facet renders.
 */
export default (context: WithRoot<DoomServerPluginContext, TeamServerScope>) => ({
  name: 'doompi/team',
  kind: 'context' as const,
  // A roster of nobody says nothing; '' is dropped from the prompt by composeSystemPrompt.
  read: () => {
    const rendered = formatTeamContextSnapshot(readActiveTeamSnapshot(context.root.channel));
    return rendered === undefined || rendered === '(no active team members)' ? '' : rendered;
  },
});
