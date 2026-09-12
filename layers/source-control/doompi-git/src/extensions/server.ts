import { defineServerPlugin } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { createGitSession } from '../controllers/gitSession';
import { api } from '../controllers/hubApi';
import { createWorktreesChannel } from '../controllers/worktreesChannel';
export const gitServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-git',
  global: { channels: [createWorktreesChannel], api: [api] },
  workspace: { channels: [createWorktreesChannel], api: [api] },
  session: createGitSession,
});
export default gitServerFacet;
