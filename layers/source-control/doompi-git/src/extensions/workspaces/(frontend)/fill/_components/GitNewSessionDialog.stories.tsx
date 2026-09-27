/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The slot props come from the contracts
 * package's testing fixture, and the host's new-session context answers the
 * branch listing from fixed data instead of a cockpit.
 */
import type { WebPluginNewSessionContext } from '@agimon-ai/doompi-core/web';
import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';

import type { GitBranchesResponse } from '../../../../../types/gitSessions';
import { GitNewSessionDialog } from './GitNewSessionDialog';

const BRANCHES: GitBranchesResponse = {
  repository: true,
  current: 'main',
  defaultBase: 'origin/main',
  local: [
    { name: 'main', checkedOutAt: '/Users/dev/workspace/doompi' },
    { name: 'feature/session-rail' },
    { name: 'fix/login-redirect' },
  ],
  remote: [{ remote: 'origin', name: 'release/0.2' }],
};

function newSession(branches: GitBranchesResponse): WebPluginNewSessionContext {
  return {
    workspaceId: 'story-workspace',
    workspaceRoot: '/Users/dev/workspace/doompi',
    close: () => undefined,
    createPlain: async () => undefined,
    openCreated: async () => undefined,
    requestWithStepUp: async () => Response.json(branches),
  };
}

const meta = {
  title: 'Git/GitNewSessionDialog',
  component: GitNewSessionDialog,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => <GitNewSessionDialog {...slotPropsFixture().props} newSession={newSession(BRANCHES)} />,
};

/** A workspace that is not a git checkout offers only a plain session. */
export const NotARepository = {
  render: () => (
    <GitNewSessionDialog
      {...slotPropsFixture().props}
      newSession={newSession({ repository: false, local: [], remote: [] })}
    />
  ),
};
