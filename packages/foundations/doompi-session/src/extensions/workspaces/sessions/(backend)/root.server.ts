import fs from 'node:fs';
import path from 'node:path';

import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { provideBackgroundWorkService } from '../../../../services/backgroundWorkService';
import { provideSessionDeliveryService } from '../../../../services/sessionDelivery';

export default defineRoot((pluginContext: DoomServerPluginContext) => ({
  value: undefined,
  services: [
    provideBackgroundWorkService,
    (context) => {
      const agent = pluginContext.agent;
      const session = agent?.context.session;
      const communication = pluginContext.host.context.sessionCommunication;
      const homeDirectory = pluginContext.host.context.homeDirectory;
      const sessionService = pluginContext.host.context.sessionService;
      if (!agent || !session?.admitPrompt || !communication || !homeDirectory || !sessionService?.canCommunicate) {
        throw new Error(
          'Session delivery requires the headless agent, authenticated session communication, host home directory, and communication policy.',
        );
      }
      const directory = path.join(homeDirectory, '.pi', '.doom', 'session', 'delivery');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      return provideSessionDeliveryService(context, {
        databasePath: path.join(directory, `${agent.context.sessionId}.sqlite`),
        recipientKey: agent.context.sessionId,
        communication,
        authorizePeer: (peerKey) => sessionService.canCommunicate?.(agent.context.sessionId, peerKey) === true,
        admitPrompt: (prompt, delivery) => session.admitPrompt!(prompt, delivery),
      });
    },
  ],
}));
