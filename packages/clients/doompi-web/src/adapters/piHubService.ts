import {
  createRemoteServiceBinding,
  createRemoteServiceEndpoint,
  RemoteServiceProvider,
  replicatedState,
  type Context,
  type RemoteServiceEndpoint,
  type RemoteServiceBinding,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
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
  type SessionServiceState,
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
      let binding: RemoteServiceBinding | undefined;
      try {
        await client.connect();
        await client.request(
          { serverId: record.protocolServerId },
          { serviceId: DoomSessionManagementService.id, member: 'attach', args: [record.id] },
          context.abortSignal,
        );
        binding = createRemoteServiceBinding({
          services: [DoomSessionService],
          transport: createClientServiceTransport(client, () => client.attachment),
          onError: (error) => options.onNotice?.(`session ${record.id} service error: ${error.message}`),
        });
        const session = binding.use(DoomSessionService);
        await binding.ready(context);
        const initial = session.state.value;
        if (!initial) throw new Error(`Session ${record.id} did not publish initial state`);
        const state = replicatedState<SessionServiceState>(initial);
        const unsubscribe = session.state.subscribe((value, publishContext) => {
          state.state.snapshot = value.snapshot;
          state.state.progress = value.progress;
          state.publish(publishContext);
        });
        const provider = new RemoteServiceProvider([{ service: DoomSessionService, mode: 'singleton' }]);
        provider.provide(DoomSessionService, {
          state,
          prompt: (text, callContext) => session.prompt(text, callContext),
          steer: (text, callContext) => session.steer(text, callContext),
          abort: (callContext) => session.abort(callContext),
          setModel: (model, callContext) => session.setModel(model, callContext),
          setThinking: (thinkingLevel, callContext) => session.setThinking(thinkingLevel, callContext),
        });
        let closed = false;
        let terminate!: (error: Error | undefined) => void;
        const terminated = new Promise<Error | undefined>((resolve) => {
          terminate = resolve;
        });
        const close = async (closeContext: Context): Promise<void> => {
          if (closed) return;
          closed = true;
          stopConnectionWatch();
          terminate(undefined);
          unsubscribe();
          provider.dispose();
          try {
            await binding?.dispose(closeContext);
          } catch (error) {
            options.onNotice?.(`session ${record.id} binding cleanup failed: ${String(error)}`);
          } finally {
            await client.dispose();
          }
        };
        // The router caches handles by session id. End this handle when its
        // process disappears so the next attach reads the new registry identity.
        const stopConnectionWatch = client.onConnectionStateChange((change) => {
          if (closed || change.state !== 'disconnected') return;
          terminate(change.error ?? new Error(`Session ${record.id} protocol disconnected`));
          void close(BACKGROUND_CONTEXT).catch((error) => {
            options.onNotice?.(`session ${record.id} connection cleanup failed: ${String(error)}`);
          });
        });
        return {
          terminated,
          attachClient: () => endpointAttachment(createRemoteServiceEndpoint(provider)),
          close,
        };
      } catch (error) {
        try {
          await binding?.dispose(context);
        } catch (cleanupError) {
          options.onNotice?.(`session ${record.id} binding cleanup failed: ${String(cleanupError)}`);
        }
        await client.dispose();
        throw error;
      }
    },
  };
}
