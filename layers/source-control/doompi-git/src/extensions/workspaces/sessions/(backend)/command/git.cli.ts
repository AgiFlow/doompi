import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createGitCommand } from '../../../../../controllers/gitCommand';
import type { GitExtensionDependencies } from '../../../../../types/extension';
import type { GitPiScope } from '../root.cli';

export default (context: WithRoot<PiPluginContext<Partial<GitExtensionDependencies>>, GitPiScope>) =>
  createGitCommand(context.root.service);
