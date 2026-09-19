import fs from 'node:fs';
import path from 'node:path';

import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { provideBackgroundWorkService } from '../../../../services/backgroundWorkService';
import { registerSessionPeerInbox } from '../../../../services/peerInbox';
import {
  createPeerCommunication,
  parseRemoteSessionReference,
  readSessionPeerConfig,
} from '../../../../services/peerTransport';
import { provideSessionDeliveryService, readDoomSessionDelivery } from '../../../../services/sessionDelivery';

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
      const peerCommunication = createPeerCommunication({ local: communication, homeDirectory });
      const peerConfig = readSessionPeerConfig(homeDirectory);
      const remotePeerIsGranted = (peerKey: string): boolean => {
        const peer = parseRemoteSessionReference(peerKey);
        return (
          peer !== undefined &&
          peerConfig?.peers.some(
            (candidate) =>
              candidate.hostId === peer.hostId && candidate.allowedSessionIds.includes(agent.context.sessionId),
          ) === true
        );
      };
      const closeDelivery = provideSessionDeliveryService(context, {
        databasePath: path.join(directory, `${agent.context.sessionId}.sqlite`),
        recipientKey: agent.context.sessionId,
        communication: peerCommunication,
        authorizePeer: (peerKey) =>
          sessionService.canCommunicate?.(agent.context.sessionId, peerKey) === true || remotePeerIsGranted(peerKey),
        admitPrompt: (prompt, delivery) => session.admitPrompt!(prompt, delivery),
      });
      const service = readDoomSessionDelivery(context);
      if (!service?.receive) throw new Error('Session peer delivery receiver was not installed.');
      const unregister = registerSessionPeerInbox(agent.context.sessionId, (sourceKey, kind, payload) =>
        service.receive?.(sourceKey, kind, payload),
      );
      return async () => {
        unregister();
        await closeDelivery();
      };
    },
  ],
}));
