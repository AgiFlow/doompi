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
  type ExtensionUiResponse,
  type FollowUpArgs,
  type ModelRef,
  type PromptArgs,
  type RewindArgs,
  type SessionCommand,
  DoomHubService,
  type HubService,
  type SessionServiceState,
  type SessionStateInfo,
  type SessionStats,
  type SteerArgs,
  type ThinkingLevel,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import type { SessionRecord } from '../types/registry.ts';

export interface PiHubServiceOptions {
  /** Every session the registry currently lists. */
  records(): readonly SessionRecord[];
  onNotice?: (message: string) => void;
  hub?: HubService;
  remote?: {
    resolve(sessionId: string): Promise<HubSessionMetadata>;
    connect(sessionId: string): Promise<{ client: Client; serverId: string; sessionId: string }>;
  };
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

function managementHost(hub?: HubService): RoutedServerServiceHost {
  return {
    attachClient(presentation) {
      const provider = new RemoteServiceProvider([
        { service: DoomSessionManagementService, mode: 'singleton' },
        ...(hub ? [{ service: DoomHubService, mode: 'singleton' as const }] : []),
      ]);
      if (hub) provider.provide(DoomHubService, hub);
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
    serverServices: managementHost(options.hub),
    async resolveSession(sessionId) {
      if (!options.records().some((record) => record.id === sessionId) && options.remote)
        return options.remote.resolve(sessionId);
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
      const local = options.records().find((record) => record.id === metadata.id);
      const endpoint = await (async () => {
        if (!local && options.remote) return options.remote.connect(metadata.id);
        const record = local ?? find(metadata.id);
        if (!record.protocolSocketPath || !record.protocolServerId)
          throw new SessionNotFoundError(`Session ${record.id} does not publish a Pi 0.85 protocol endpoint`);
        return {
          sessionId: record.id,
          serverId: record.protocolServerId,
          client: new Client({
            serverId: record.protocolServerId,
            transportFactory: createUnixTransportFactory({ path: record.protocolSocketPath }),
            onListenerError: (error) => options.onNotice?.(`session ${metadata.id} listener error: ${error.message}`),
          }),
        };
      })();
      const { client } = endpoint;
      let binding: RemoteServiceBinding | undefined;
      try {
        await client.connect();
        await client.request(
          { serverId: endpoint.serverId },
          { serviceId: DoomSessionManagementService.id, member: 'attach', args: [endpoint.sessionId] },
          context.abortSignal,
        );
        binding = createRemoteServiceBinding({
          services: [DoomSessionService],
          transport: createClientServiceTransport(client, () => client.attachment),
          onError: (error) => options.onNotice?.(`session ${metadata.id} service error: ${error.message}`),
        });
        const session = binding.use(DoomSessionService);
        await binding.ready(context);
        const initial = session.state.value;
        if (!initial) throw new Error(`Session ${metadata.id} did not publish initial state`);
        const state = replicatedState<SessionServiceState>(initial);
        const unsubscribe = session.state.subscribe((value, publishContext) => {
          state.state.snapshot = value.snapshot;
          state.state.progress = value.progress;
          state.state.presentation = value.presentation;
          state.state.inFlight = value.inFlight;
          state.publish(publishContext);
        });
        const provider = new RemoteServiceProvider([{ service: DoomSessionService, mode: 'singleton' }]);
        provider.provide(DoomSessionService, {
          state,
          prompt: (input: string | PromptArgs, callContext) =>
            typeof input === 'string' ? session.prompt(input, callContext) : session.prompt(input, callContext),
          steer: (input: string | SteerArgs, callContext) =>
            typeof input === 'string' ? session.steer(input, callContext) : session.steer(input, callContext),
          abort: (callContext) => session.abort(callContext),
          setModel: (model: ModelRef, callContext) => session.setModel(model, callContext),
          setThinking: (thinkingLevel: ThinkingLevel, callContext) => session.setThinking(thinkingLevel, callContext),
          followUp: (args: FollowUpArgs, callContext) => session.followUp(args, callContext),
          clearQueue: (callContext) => session.clearQueue(callContext),
          rewind: (args: RewindArgs, callContext) => session.rewind(args, callContext),
          extensionUiResponse: (response: ExtensionUiResponse, callContext) =>
            session.extensionUiResponse(response, callContext),
          getState: (callContext): Promise<SessionStateInfo> => session.getState(callContext),
          getSessionStats: (callContext): Promise<SessionStats> => session.getSessionStats(callContext),
          getCommands: (callContext): Promise<SessionCommand[]> => session.getCommands(callContext),
          getAvailableModels: (callContext): Promise<ModelRef[]> => session.getAvailableModels(callContext),
          getAvailableThinkingLevels: (callContext): Promise<ThinkingLevel[]> =>
            session.getAvailableThinkingLevels(callContext),
          compact: (instructions, callContext) => session.compact(instructions, callContext),
          setName: (name, callContext) => session.setName(name, callContext),
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
            options.onNotice?.(`session ${metadata.id} binding cleanup failed: ${String(error)}`);
          } finally {
            await client.dispose();
          }
        };
        // The router caches handles by session id. End this handle when its
        // process disappears so the next attach reads the new registry identity.
        const stopConnectionWatch = client.onConnectionStateChange((change) => {
          if (closed || change.state !== 'disconnected') return;
          terminate(change.error ?? new Error(`Session ${metadata.id} protocol disconnected`));
          void close(BACKGROUND_CONTEXT).catch((error) => {
            options.onNotice?.(`session ${metadata.id} connection cleanup failed: ${String(error)}`);
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
          options.onNotice?.(`session ${metadata.id} binding cleanup failed: ${String(cleanupError)}`);
        }
        await client.dispose();
        throw error;
      }
    },
  };
}
