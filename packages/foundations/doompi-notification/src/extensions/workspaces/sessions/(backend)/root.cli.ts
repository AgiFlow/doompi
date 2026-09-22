import { SUBAGENT_CHILD_ENV } from '@agimon-ai/doompi-core/childProcess';
import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createNotificationRuntime } from '../../../../services/notificationRuntime';
import type { NotificationExtensionOptions } from '../../../../types/notifications';
export default defineRoot((context: PiPluginContext<NotificationExtensionOptions>) => {
  if ((context.options?.environment ?? process.env)[SUBAGENT_CHILD_ENV]) return { value: undefined };
  if (!context.runtime) throw new Error('This Pi extension requires the Cordis runtime metadata.');
  const runtime = createNotificationRuntime({
    pi: context.pi,
    options: context.options ?? {},
    generation: `${context.runtime.generation}:notification`,
  });
  return { value: runtime, services: runtime.services, onStop: runtime.onStop, onDispose: runtime.onDispose };
});
