import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

import { subagentsTab } from '../_components/SubagentsPanel';
import { openCatalog } from '../_lib/catalogStore';
import { AGENTS_GROUP } from './_lib/leaderGroups';

/** SPC a l: pick an agent and launch it. The filename is the binding's local name. */
export default defineLeaderBinding({
  path: [AGENTS_GROUP, { key: 'l', label: 'launch', detail: 'pick an agent and launch it' }],
  run: (context) => {
    if (context.sessionId !== null) openCatalog(context.sessionId);
    context.openTransientTab(subagentsTab());
  },
});
