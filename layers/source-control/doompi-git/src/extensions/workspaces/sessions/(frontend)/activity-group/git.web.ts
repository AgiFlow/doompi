import { defineActivityGroup } from '@agimon-ai/doompi-core/web';

import { worktreesTab } from '../_components/WorktreesPanel';
import { gitChangesActivitySource } from '../_lib/gitChangesStore';
import { worktreeActivitySource } from '../_lib/worktreesActivityStore';

export default defineActivityGroup({
  keys: 'g w',
  activeSource: {
    subscribe(listener) {
      const stopWorktrees = worktreeActivitySource.subscribe(listener);
      const stopChanges = gitChangesActivitySource.subscribe(listener);
      return () => {
        stopWorktrees();
        stopChanges();
      };
    },
    isActive(sessionId) {
      return worktreeActivitySource.isActive(sessionId) || gitChangesActivitySource.isActive(sessionId);
    },
  },
  marksBackgroundWork: false,
  transientTab: worktreesTab,
  order: 30,
});
