import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { gitToolRenderers } from './components/toolRenderers.ts';
import { WorktreesActivitySection } from './components/WorktreesActivitySection.tsx';
import { worktreesTab } from './components/WorktreesPanel.tsx';
import { startWorktreeRuntime, worktreeActivitySource, worktreesChannel } from './stores/worktreesActivityStore.ts';

/** The named export the generated plugin registry imports. */
export const webPlugin = defineWebPlugin({
  id: 'git',
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
});
