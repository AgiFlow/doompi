import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

type AutoStopPiScope = Awaited<ReturnType<typeof import('../root.cli').default>>['value'];
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, AutoStopPiScope>) =>
    (_event: unknown, execution: Parameters<AutoStopPiScope['settled']>[0]) =>
      context.root.settled(execution),
  {},
);
