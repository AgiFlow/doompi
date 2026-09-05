import {
  createRemoteServiceEndpoint,
  RemoteServiceProvider,
  replicatedState,
  type Context,
  type MutableReplicatedState,
  type RemoteServiceEndpoint,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { RoutedServerServiceHost, RoutedSessionHandle, ServerHost } from '@earendil-works/pi-server';
import { SessionNotFoundError } from '@earendil-works/pi-server';
import { createRpcTranscript, type RpcTranscript } from '../services/rpcTranscript.ts';
import type { AgentProcess } from '../types/session.ts';
import {
  DoomSessionManagementService,
  DoomSessionService,
  type ModelRef,
  type SessionServiceState,
  type SessionSnapshot,
  type ThinkingLevel,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { observe, type ServerTelemetry } from './serverTelemetry.ts';

const SETTLED = 'agent_settled';

export interface AgentSessionRuntimeOptions {
  agent: AgentProcess;
  sessionId: string;
  sessionName: string;
  cwd: string;
  telemetry?: ServerTelemetry;
  /** Test seam for the projection. */
  transcript?: RpcTranscript;
}

export interface AgentSessionRuntime {
  readonly state: MutableReplicatedState<SessionServiceState>;
  prompt(text: string, context: Context): Promise<void>;
  steer(text: string, context: Context): Promise<void>;
  abort(context: Context): Promise<void>;
  setModel(model: ModelRef, context: Context): Promise<void>;
  setThinking(thinkingLevel: ThinkingLevel, context: Context): Promise<void>;
  dispose(): Promise<void>;
}

/** Projects one supervised RPC agent as a Chord session service. */
export function createAgentSessionRuntime(options: AgentSessionRuntimeOptions): AgentSessionRuntime {
  const transcript =
    options.transcript ??
    createRpcTranscript({ id: options.sessionId, cwd: options.cwd, name: options.sessionName, now: Date.now });
  const state = replicatedState<SessionServiceState>({ snapshot: transcript.snapshot(), progress: null });
  const settlers = new Set<() => void>();
  let disposed = false;

  options.agent.onFrame((frame) => {
    const reduction = transcript.apply(frame);
    if (reduction.aggregate && options.telemetry) {
      observe(
        options.telemetry.recordEvent('doompi_server.transcript.aggregate', {
          session_id: options.sessionId,
          ...reduction.aggregate,
        }),
      );
    }
    if (reduction.snapshot) state.state.snapshot = reduction.snapshot;
    state.state.progress = reduction.progress ?? null;
    if (reduction.snapshot || reduction.progress) state.publish(BACKGROUND_CONTEXT);
    if (frame.type === SETTLED) {
      const waiting = [...settlers];
      settlers.clear();
      for (const settle of waiting) settle();
    }
  });

  const requireLive = (): void => {
    if (disposed) throw new Error('The session runtime is disposed');
  };
  const awaitSettled = (): Promise<void> =>
    new Promise((resolve) => {
      settlers.add(resolve);
    });

  return {
    state,
    async prompt(text) {
      requireLive();
      if (transcript.phase() !== 'idle') throw new Error('A turn is already running');
      const settled = awaitSettled();
      const run = async (): Promise<void> => {
        options.agent.send({ type: 'prompt', message: text });
        await settled;
      };
      if (options.telemetry) {
        await options.telemetry.runInSpan('doompi_server.prompt_to_settled', { session_id: options.sessionId }, run);
      } else {
        await run();
      }
    },
    async steer(text) {
      requireLive();
      if (transcript.phase() === 'idle') throw new Error('There is no active turn to steer');
      options.agent.send({ type: 'steer', message: text });
    },
    async abort() {
      requireLive();
      if (transcript.phase() === 'idle') throw new Error('There is no active turn to abort');
      options.agent.send({ type: 'abort' });
    },
    async setModel(model) {
      requireLive();
      options.agent.send({ type: 'set_model', provider: model.provider, modelId: model.id });
    },
    async setThinking(thinkingLevel) {
      requireLive();
      options.agent.send({ type: 'set_thinking_level', level: thinkingLevel });
    },
    async dispose() {
      disposed = true;
      settlers.clear();
    },
  };
}

export interface AgentServerServiceOptions extends AgentSessionRuntimeOptions {
  createdAt: number;
}

export interface DoomSessionMetadata {
  id: string;
  createdAt: number;
  storageVersion: number;
  cwd: string;
  sessionName: string;
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

/** Creates the 0.85 routed host for one supervised DoomPi session. */
export function createAgentServerService(options: AgentServerServiceOptions): ServerHost<DoomSessionMetadata> {
  const metadata: DoomSessionMetadata = {
    id: options.sessionId,
    createdAt: options.createdAt,
    storageVersion: 1,
    cwd: options.cwd,
    sessionName: options.sessionName,
  };
  const runtime = createAgentSessionRuntime(options);
  let closed = false;

  return {
    serverServices: managementHost(),
    async resolveSession(sessionId) {
      if (sessionId !== metadata.id) throw new SessionNotFoundError(`No session ${sessionId}`);
      return metadata;
    },
    async openSession() {
      if (closed) throw new SessionNotFoundError('The session service is closed');
      const provider = new RemoteServiceProvider([{ service: DoomSessionService, mode: 'singleton' }]);
      provider.provide(DoomSessionService, runtime);
      const handle: RoutedSessionHandle = {
        attachClient: () => endpointAttachment(createRemoteServiceEndpoint(provider)),
        async close() {
          if (closed) return;
          closed = true;
          provider.dispose();
          await runtime.dispose();
        },
      };
      return handle;
    },
  };
}

export type { SessionSnapshot };
