import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createGitDependencies } from '../../../../services/gitDependencies';
import type { GitExtensionDependencies } from '../../../../types/extension';

const root = defineRoot((context: PiPluginContext<Partial<GitExtensionDependencies>>) => ({
  value: createGitDependencies(context.options),
}));

export type GitPiScope = ReturnType<typeof root>['value'];
export default root;
