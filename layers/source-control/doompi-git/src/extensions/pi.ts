// @scaffold-generated
import { definePiExtension, definePiTool } from '@agimon-ai/doompi-core/pi-extension';

import { createGitCommand } from '../controllers/gitCommand';
import { createGitDependencies } from '../services/gitDependencies';
import { createRunWorktreeTool } from '../tools/runWorktree';
import type { GitExtensionDependencies } from '../types/extension';

const PACKAGE_SOURCE = '@agimon-ai/doompi-git';

export const activateGitExtension = definePiExtension<Partial<GitExtensionDependencies>>(
  PACKAGE_SOURCE,
  ({ options }) => {
    const dependencies = createGitDependencies(options);
    return {
      commands: [createGitCommand(dependencies.service)],
      tools: [definePiTool(createRunWorktreeTool(dependencies.operations))],
      resources: [
        {
          source: PACKAGE_SOURCE,
          moduleUrl: import.meta.url,
          skills: [
            {
              name: 'doompi-use-git',
              description:
                'Use @agimon-ai/doompi-git: Git worktree sessions for DoomPi: spawn an isolated worktree with its own session and manage it from the parent',
            },
          ],
        },
      ],
    };
  },
);
export default activateGitExtension;
