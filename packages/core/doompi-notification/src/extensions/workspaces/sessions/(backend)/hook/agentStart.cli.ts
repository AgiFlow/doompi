import { defineRoutedContribution } from '@agimon-ai/doompi-core/extension-file';
import type { WithRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createNotificationRuntime } from '../_lib/notificationRuntime';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createNotificationRuntime> | undefined>) =>
    context.root?.events?.agent_start,
  { cardinality: 'optional' },
);
