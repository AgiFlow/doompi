import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { worktreesTab } from '../_components/WorktreesPanel';
import { worktreeActivitySource } from '../_lib/worktreesActivityStore';

export default defineActivityGroup({
  keys: 'g w',
  activeSource: worktreeActivitySource,
  marksBackgroundWork: false,
  transientTab: worktreesTab,
  order: 30,
});
