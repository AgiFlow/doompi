import {
  createRemoteServiceBinding,
  createRemoteServiceEndpoint,
  RemoteServiceProvider,
  type Context,
  type RemoteServiceEndpoint,
} from '@earendil-works/chord';
import { Client, createClientServiceTransport } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';
import {
  SessionNotFoundError,
  type RoutedServerServiceHost,
  type RoutedSessionHandle,
  type ServerHost,
} from '@earendil-works/pi-server';
import {
  DoomSessionManagementService,
  DoomSessionService,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import type { SessionRecord } from '../types/registry.ts';
import type { SpawnSessionInput, SpawnOutcome } from './serverSpawner.ts';

export interface PiHubServiceOptions {
  /** Every session the registry currently lists. */
  records(): readonly SessionRecord[];
  spawn(input: SpawnSessionInput): Promise<SpawnOutcome>;
  onNotice?: (message: string) => void;
}

export interface HubSessionMetadata {
  id: string;
  createdAt: number;
  storageVersion: number;
  cwd: string;
}

function endpointAttachment(endpoint: RemoteServiceEndpoint): {
  invokeService: RemoteServiceEndpoint['invoke'];
  release(): void;
} {
  return {
    invokeService: (call, publish, context) => endpoint.invoke(call, publish, context),
    release: () => endpoint.dispose(),
  };
}

function managementHost(): RoutedServerServiceHost {
  return {
    attachClient(presentation) {
      const provider = new RemoteServiceProvider([{ service: DoomSessionManagementService, mode: 'singleton' }]);
      provider.provide(DoomSessionManagementService, {
        attach: (sessionId, context) => presentation.attachSession(sessionId, context),
        detach: (context) => presentation.detachSession(context),
      });
      return endpointAttachment(createRemoteServiceEndpoint(provider));
    },
  };
}

/** Routes the cockpit's Pi 0.85 server to each session's own protocol host. */
export function createPiHubService(options: PiHubServiceOptions): ServerHost<HubSessionMetadata> {
  const find = (sessionId: string): SessionRecord => {
    const record = options.records().find((candidate) => candidate.id === sessionId);
    if (!record) throw new SessionNotFoundError(`No session ${sessionId}`);
    return record;
  };

  return {
    serverServices: managementHost(),
    async resolveSession(sessionId) {
      const record = find(sessionId);
      const createdAt = Date.parse(record.createdAt);
      return {
        id: record.id,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        storageVersion: 1,
        cwd: record.cwd,
      };
    },
    async openSession(metadata, context): Promise<RoutedSessionHandle> {
      const record = find(metadata.id);
      if (!record.protocolSocketPath || !record.protocolServerId) {
        throw new SessionNotFoundError(`Session ${record.id} does not publish a Pi 0.85 protocol endpoint`);
      }
      const client = new Client({
        serverId: record.protocolServerId,
        transportFactory: createUnixTransportFactory({ path: record.protocolSocketPath }),
        onListenerError: (error) => options.onNotice?.(`session ${record.id} listener error: ${error.message}`),
      });
      await client.connect();
      try {
        await client.request(
          { serverId: record.protocolServerId },
          { serviceId: DoomSessionManagementService.id, member: 'attach', args: [record.id] },
          context.abortSignal,
        );
        const binding = createRemoteServiceBinding({
          services: [DoomSessionService],
          transport: createClientServiceTransport(client, () => client.attachment),
          onError: (error) => options.onNotice?.(`session ${record.id} service error: ${error.message}`),
        });
        const session = binding.use(DoomSessionService);
        await binding.ready(context);
        const provider = new RemoteServiceProvider([{ service: DoomSessionService, mode: 'singleton' }]);
        provider.provide(DoomSessionService, {
          state: session.state,
          prompt: (text, callContext) => session.prompt(text, callContext),
          steer: (text, callContext) => session.steer(text, callContext),
          abort: (callContext) => session.abort(callContext),
          setModel: (model, callContext) => session.setModel(model, callContext),
          setThinking: (thinkingLevel, callContext) => session.setThinking(thinkingLevel, callContext),
        });
        let closed = false;
        return {
          attachClient: () => endpointAttachment(createRemoteServiceEndpoint(provider)),
          async close(closeContext: Context) {
            if (closed) return;
            closed = true;
            provider.dispose();
            await binding.dispose(closeContext);
            await client.dispose();
          },
        };
      } catch (error) {
        await client.dispose();
        throw error;
      }
    },
  };
}
