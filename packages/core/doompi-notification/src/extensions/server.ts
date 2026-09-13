import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { notificationCommand } from '../controllers/notificationCommand';

export const notificationServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-notification',
  session: { commands: [notificationCommand] },
});
export default notificationServerFacet;
