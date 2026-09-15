import { defineCliHook, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import type { AuthorExtensionDependencies } from '../../../../../types/extension';
type AuthorPiScope = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];

export default defineCliHook(
  (context: WithRoot<PiPluginContext<Partial<AuthorExtensionDependencies>>, AuthorPiScope>) =>() =>
    context.root.mode.mode.publish(),
);
