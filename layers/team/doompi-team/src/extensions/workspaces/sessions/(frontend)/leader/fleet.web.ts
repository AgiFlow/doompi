import { defineLeaderBinding } from '@agimon-ai/doompi-core/web';

import { subagentsTab } from '../../../../../web/components/SubagentsPanel';
import { AGENTS_GROUP } from '../../../../../web/lib/leaderGroups';

/** SPC a r: the runs in this session. The filename is the binding's local name. */
export default defineLeaderBinding({
  path: [AGENTS_GROUP, { key: 'r', label: 'runs', detail: 'runs in this session' }],
  run: (context) => context.openTransientTab(subagentsTab()),
});
