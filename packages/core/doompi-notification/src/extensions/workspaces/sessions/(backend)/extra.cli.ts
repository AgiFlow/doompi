import { SUBAGENT_CHILD_ENV } from '@agimon-ai/doompi-core/child-process';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import {
  createNotificationRuntime,
  type NotificationExtensionOptions,
} from '../../../../controllers/notificationRuntime';

/** Detached children leave notification ownership with their parent session. */
export default ({ pi, options, runtime }: PiPluginContext<NotificationExtensionOptions>) => {
  if ((options?.environment ?? process.env)[SUBAGENT_CHILD_ENV]) return {};
  if (!runtime) throw new Error('This Pi extension requires the Cordis runtime metadata.');
  return createNotificationRuntime({ pi, options: options ?? {}, generation: `${runtime.generation}:notification` });
};
