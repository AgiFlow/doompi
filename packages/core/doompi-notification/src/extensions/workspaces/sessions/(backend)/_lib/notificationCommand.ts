import { defineCommand } from '@agimon-ai/doompi-core/server-facet';

export const notificationCommand = defineCommand({
  name: 'notify',
  description: 'Send a notification through the active headless client.',
  async execute(args, execution) {
    const body = args.trim();
    if (body) await execution.notify({ body, level: 'info' });
  },
});
