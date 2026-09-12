import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { SUBAGENT_CHILD_ENV } from '@agimon-ai/doompi-core/child-process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createNotificationRuntime, type NotificationExtensionOptions } from '../controllers/notificationRuntime';

const notificationPlugin = definePiExtension<NotificationExtensionOptions>(
  '@agimon-ai/doompi-notification',
  ({ pi, options, runtime }) => {
    if (!runtime) throw new Error('This Pi extension requires the Cordis runtime metadata.');
    return createNotificationRuntime({ pi, options: options ?? {}, generation: `${runtime.generation}:notification` });
  },
);

/** Detached children leave notification ownership with their parent session. */
export async function notificationExtension(
  pi: ExtensionAPI,
  options: NotificationExtensionOptions = {},
): Promise<void> {
  if ((options.environment ?? process.env)[SUBAGENT_CHILD_ENV]) return;
  await notificationPlugin(pi, options);
}
export default notificationExtension;
