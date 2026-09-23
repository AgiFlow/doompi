import fs from 'node:fs';
import path from 'node:path';

import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { provideBackgroundWorkService } from '../../../../services/backgroundWorkService';
import { registerSessionPeerInbox } from '../../../../services/peerInbox';
import {
  createPeerCommunication,
  parseRemoteSessionReference,
  peerSessionReference,
  readSessionPeerConfig,
} from '../../../../services/peerTransport';
import { provideSessionDeliveryService } from '../../../../services/sessionDelivery';
import { createSessionDirectory } from '../../../../services/sessionDirectory';
import { createSessionGroupStore } from '../../../../services/sessionGroups';
import {
  DOOM_SESSION_INTERCOM_SERVICE,
  createSessionGroupDeliveryAuthorizer,
  createSessionIntercom,
} from '../../../../services/sessionIntercom';

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
      const sessionDirectory = path.join(homeDirectory, '.pi', '.doom', 'session');
      const deliveryDirectory = path.join(sessionDirectory, 'delivery');
      fs.mkdirSync(deliveryDirectory, { recursive: true, mode: 0o700 });
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
      const fallbackAuthorization = (peerKey: string): boolean =>
        sessionService.canCommunicate?.(agent.context.sessionId, peerKey) === true || remotePeerIsGranted(peerKey);
      const groups = peerConfig
        ? createSessionGroupStore({ databasePath: path.join(sessionDirectory, 'groups.sqlite') })
        : undefined;
      const localHostId = peerConfig?.hostId;
      const selfReference = localHostId ? peerSessionReference(localHostId, agent.context.sessionId) : undefined;
      const groupAuthorization =
        groups && selfReference && localHostId
          ? createSessionGroupDeliveryAuthorizer({
              selfReference,
              groups,
              peerReference: (peerKey) =>
                parseRemoteSessionReference(peerKey) === undefined
                  ? peerSessionReference(localHostId, peerKey)
                  : peerKey,
              fallback: fallbackAuthorization,
            })
          : undefined;
      const { service, close: closeDelivery } = provideSessionDeliveryService(context, {
        databasePath: path.join(deliveryDirectory, `${agent.context.sessionId}.sqlite`),
        recipientKey: agent.context.sessionId,
        communication: peerCommunication,
        authorizePeer: (peerKey, metadata) => groupAuthorization?.(peerKey, metadata) ?? fallbackAuthorization(peerKey),
        admitPrompt: (prompt, delivery) => session.admitPrompt!(prompt, delivery),
      });
      const unprovide: (() => void)[] = [];
      if (groups && selfReference && peerConfig) {
        const directory = createSessionDirectory({
          authorizeDiscovery: (caller, subject) => {
            const reference = peerSessionReference(subject.hostId, subject.sessionId);
            const permitted = groups.groupsFor(caller).some((group) => group.members.includes(reference));
            return permitted ? { capabilities: ['message'] } : undefined;
          },
        });
        for (const peer of peerConfig.peers)
          for (const sessionId of peer.allowedSessionIds)
            directory.observe({
              hostId: peer.hostId,
              sessionId,
              hostIncarnation: 'unknown',
              sessionIncarnation: 'unknown',
              sequence: 0,
              observedAt: 0,
              staleAfterMs: 0,
              deliveryTarget: peerSessionReference(peer.hostId, sessionId),
              reachability: 'unknown',
              runtime: 'unknown',
              activity: 'unknown',
              voice: { eligible: 'unknown', readiness: 'unknown' },
            });
        unprovide.push(
          context.provide(
            DOOM_SESSION_INTERCOM_SERVICE,
            createSessionIntercom({ selfReference, directory, groups, delivery: service }),
          ),
        );
      }
      const unregister = registerSessionPeerInbox(agent.context.sessionId, (sourceKey, kind, payload) =>
        service.receive?.(sourceKey, kind, payload),
      );
      return async () => {
        unregister();
        for (const release of unprovide.reverse()) release();
        await closeDelivery();
        groups?.close();
      };
    },
  ],
}));
