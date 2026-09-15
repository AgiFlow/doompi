import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { worktreesTab } from '../../../../../web/components/WorktreesPanel';
import { worktreeActivitySource } from '../../../../../web/stores/worktreesActivityStore';

export default defineActivityGroup({
  keys: 'g w',
  activeSource: worktreeActivitySource,
  marksBackgroundWork: false,
  transientTab: worktreesTab,
  order: 30,
});
