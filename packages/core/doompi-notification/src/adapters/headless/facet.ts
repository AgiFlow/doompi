import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessCommand,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';

export const notificationHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const command: DoomHeadlessCommand = {
      name: 'notify',
      description: 'Send a notification through the active headless client.',
      async execute(args, execution) {
        const body = args.trim();
        if (!body) return;
        await execution.client.notify({ body, level: 'info' });
      },
    };
    const registration = host.registerCommand(command);
    return () => registration.dispose();
  },
};
