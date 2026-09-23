import { defineRoutedContribution } from '@agimon-ai/doompi-core/extensionFile';
import type { WithRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createNotificationRuntime } from '../../../../../services/notificationRuntime';
export default defineRoutedContribution(
  (context: WithRoot<PiPluginContext<unknown>, ReturnType<typeof createNotificationRuntime> | undefined>) =>
    context.root?.events?.agent_settled,
  { cardinality: 'optional' },
);
