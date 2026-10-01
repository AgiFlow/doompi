import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';

import { startGitChangesRuntime } from '../../_lib/gitChangesStore';
import { startWorktreeRuntime } from '../../_lib/worktreesActivityStore';

/** Binds both hub channels' senders: worktrees, and this session's diff and sync. */
export default function startGitRuntime(runtime: WebPluginRuntime): () => void {
  const stopWorktrees = startWorktreeRuntime(runtime);
  const stopChanges = startGitChangesRuntime(runtime);
  return () => {
    stopChanges();
    stopWorktrees();
  };
}
