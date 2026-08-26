import type {
  ModelRef,
  SessionMetadata,
  SessionPhase,
  SessionSnapshot,
  ThinkingLevel,
} from '@earendil-works/pi-protocol';
import { PiServerError } from '@earendil-works/pi-server';
import type {
  CreateSessionOptions,
  PiServerService,
  PiSessionRuntime,
  PiSessionRuntimeEvent,
  PromptInput,
  SteerInput,
} from '@earendil-works/pi-server';
import { createRpcTranscript, type RpcTranscript } from '../services/rpcTranscript.ts';
import type { AgentProcess } from '../types/session.ts';

const SETTLED = 'agent_settled';

export interface AgentSessionRuntimeOptions {
  agent: AgentProcess;
  sessionId: string;
  sessionName: string;
  cwd: string;
  /** Test seam for the projection. */
  transcript?: RpcTranscript;
}

/**
 * One acquired DoomPi session, presented as a protocol runtime.
 *
 * Pi's rpc mode answers a prompt the moment it accepts one and reports the
 * turn as a stream afterwards, while the protocol expects `prompt()` to settle
 * when the turn does. Bridging that is this adapter's main job: it holds the
 * caller until the agent says it settled, so a client's request completes at
 * the point the transcript is actually final.
 */
export function createAgentSessionRuntime(options: AgentSessionRuntimeOptions): PiSessionRuntime {
  const transcript =
    options.transcript ??
    createRpcTranscript({ id: options.sessionId, cwd: options.cwd, name: options.sessionName, now: Date.now });
  const listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
  const settlers = new Set<() => void>();
  let disposed = false;

  const emit = (event: PiSessionRuntimeEvent): void => {
    for (const listener of listeners) listener(event);
  };

  options.agent.onFrame((frame) => {
    const reduction = transcript.apply(frame);
    if (reduction.snapshot) emit({ type: 'snapshot' });
    if (reduction.progress) emit({ type: 'progress', progress: reduction.progress });
    if (frame.type === SETTLED) {
      // Copied before draining: a settler may start the next turn.
      const waiting = [...settlers];
      settlers.clear();
      for (const settle of waiting) settle();
    }
  });

  /** Resolves when the agent reports it settled, or immediately if it already has. */
  const awaitSettled = (): Promise<void> =>
    new Promise((resolve) => {
      settlers.add(resolve);
    });

  const requireLive = (): void => {
    if (disposed) throw new PiServerError('not_found', 'The session runtime is disposed');
  };

  return {
    snapshot: () => transcript.snapshot(),
    getPhase: (): SessionPhase => transcript.phase(),

    async prompt(input: PromptInput) {
      requireLive();
      if (transcript.phase() !== 'idle') throw new PiServerError('busy', 'A turn is already running');
      const settled = awaitSettled();
      options.agent.send({ type: 'prompt', message: input.text });
      await settled;
    },

    async steer(input: SteerInput) {
      requireLive();
      if (transcript.phase() === 'idle') throw new PiServerError('busy', 'There is no active turn to steer');
      options.agent.send({ type: 'steer', message: input.text });
    },

    async abort() {
      requireLive();
      if (transcript.phase() === 'idle') throw new PiServerError('busy', 'There is no active turn to abort');
      options.agent.send({ type: 'abort' });
    },

    async setModel(model: ModelRef) {
      requireLive();
      options.agent.send({ type: 'set_model', provider: model.provider, modelId: model.id });
    },

    async setThinking(thinkingLevel: ThinkingLevel) {
      requireLive();
      options.agent.send({ type: 'set_thinking_level', level: thinkingLevel });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async dispose() {
      // Releasing a client's hold must not take the agent down: the server
      // owns its lifetime, and another client may attach a moment later.
      disposed = true;
      listeners.clear();
      settlers.clear();
    },
  };
}

export interface AgentServerServiceOptions extends AgentSessionRuntimeOptions {
  createdAt: number;
}

/**
 * The single supervised session, served through the protocol's service contract.
 *
 * This server exists to supervise exactly one agent, so creating a session is
 * refused rather than silently handing back the running one, and every open
 * returns a fresh hold on the same runtime.
 */
export function createAgentServerService(options: AgentServerServiceOptions): PiServerService {
  const metadata: SessionMetadata = {
    id: options.sessionId,
    createdAt: options.createdAt,
    sessionName: options.sessionName,
    cwd: options.cwd,
  };
  const runtime = createAgentSessionRuntime(options);
  // The runtime is shared, so a client releasing its hold must not disable the
  // session for the next one. Only the server's own shutdown ends it.
  const shared: PiSessionRuntime = { ...runtime, dispose: async () => undefined };

  return {
    listSessions: async () => [metadata],
    listModels: async () => [],
    async createSession(_create: CreateSessionOptions): Promise<PiSessionRuntime> {
      throw new PiServerError('not_implemented', 'This server supervises one session and cannot create another');
    },
    async openSession(sessionId: string): Promise<PiSessionRuntime> {
      if (sessionId !== options.sessionId) throw new PiServerError('not_found', `No session ${sessionId}`);
      return shared;
    },
  };
}

export type { SessionSnapshot };
