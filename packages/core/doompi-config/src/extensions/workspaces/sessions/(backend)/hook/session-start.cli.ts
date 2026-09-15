import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

type ConfigPiScope = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext, ConfigPiScope>) => context.root.onSessionStart,
  {},
);
