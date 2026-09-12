import { defineWebPlugin } from '@agimon-ai/doompi-core/web';
import { gitToolRenderers } from '../web/components/toolRenderers';
import { WorktreesActivitySection } from '../web/components/WorktreesActivitySection';
import { worktreesTab } from '../web/components/WorktreesPanel';
import { startWorktreeRuntime, worktreeActivitySource, worktreesChannel } from '../web/stores/worktreesActivityStore';

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'git',
  session: {
    channels: [worktreesChannel],
    // The panel commands the hub over its own channel, which needs the page's
    // hub socket rather than the per-session frame sender the slots carry.
    start: startWorktreeRuntime,
    activityGroups: [
      {
        name: 'git',
        keys: 'g w',
        // The source keeps the group present while idle, which is exactly when
        // its launcher matters: a repository with no worktrees is where someone
        // wants to make the first one.
        activeSource: worktreeActivitySource,
        // A standing worktree is not background work in progress; it is state.
        marksBackgroundWork: false,
        transientTab: worktreesTab,
        order: 30,
      },
    ],
    activitySections: [{ id: 'git', component: WorktreesActivitySection }],
    toolRenderers: gitToolRenderers,
  },
});
