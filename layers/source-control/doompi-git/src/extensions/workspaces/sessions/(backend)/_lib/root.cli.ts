import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createGitDependencies } from '../../../../../services/gitDependencies';
import type { GitExtensionDependencies } from '../../../../../types/extension';

const root = defineRoot((context: PiPluginContext<Partial<GitExtensionDependencies>>) => ({
  value: createGitDependencies(context.options),
}));

export type GitPiScope = Awaited<ReturnType<typeof root>>['value'];
export default root;
