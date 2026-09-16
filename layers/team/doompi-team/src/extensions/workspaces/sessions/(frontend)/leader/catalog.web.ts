import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

import { subagentsTab } from '../../../../../web/components/SubagentsPanel';
import { AGENTS_GROUP } from '../../../../../web/lib/leaderGroups';
import { openCatalog } from '../../../../../web/stores/catalogStore';

/** SPC a l: pick an agent and launch it. The filename is the binding's local name. */
export default defineLeaderBinding({
  path: [AGENTS_GROUP, { key: 'l', label: 'launch', detail: 'pick an agent and launch it' }],
  run: (context) => {
    if (context.sessionId !== null) openCatalog(context.sessionId);
    context.openTransientTab(subagentsTab());
  },
});
