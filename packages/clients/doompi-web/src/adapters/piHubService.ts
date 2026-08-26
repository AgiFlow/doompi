import { PiClient } from '@earendil-works/pi-client';
import { createUnixTransportFactory } from '@earendil-works/pi-client/unix';
import type { SessionLease } from '@earendil-works/pi-client';
import type { ModelMetadata, SessionMetadata } from '@earendil-works/pi-protocol';
import { PiServerError } from '@earendil-works/pi-server';
import type { CreateSessionOptions, PiServerService, PiSessionRuntime } from '@earendil-works/pi-server';
import type { SessionRecord } from '../types/registry.ts';
import type { SpawnSessionInput, SpawnOutcome } from './serverSpawner.ts';

/** How long a created session has to publish its record before the client is told it failed. */
const CREATE_TIMEOUT_MS = 10_000;
const CREATE_POLL_MS = 100;

export interface PiHubServiceOptions {
  /** Every session the registry currently lists. */
  records(): readonly SessionRecord[];
  spawn(input: SpawnSessionInput): Promise<SpawnOutcome>;
  onNotice?: (message: string) => void;
}

function toMetadata(record: SessionRecord): SessionMetadata {
  const createdAt = Date.parse(record.createdAt);
  return {
    id: record.id,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    sessionName: record.name,
    cwd: record.cwd,
  };
}

/**
 * Presents one live lease on a session's own server as a runtime.
 *
 * The hub owns no session state of its own here. It holds a connection open
 * and forwards, so the snapshot a browser reads is the one the session server
 * published rather than a copy the hub reduced for itself.
 */
function leaseRuntime(client: PiClient, lease: SessionLease): PiSessionRuntime {
  const snapshot = () => {
    const current = lease.snapshot;
    if (!current) throw new PiServerError('not_found', 'The session has not published a snapshot yet');
    return current;
  };
  return {
    snapshot,
    getPhase: () => snapshot().phase,
    prompt: async (input) => void (await lease.prompt(input.text)),
    steer: async (input) => void (await lease.steer(input.text)),
    abort: async () => void (await lease.abort()),
    setModel: async (model) => void (await lease.setModel(model)),
    setThinking: async (level) => void (await lease.setThinking(level)),
    subscribe(listener) {
      const stopSnapshots = lease.subscribe(() => listener({ type: 'snapshot' }));
      const stopEvents = lease.onEvent((event) => {
        if (event.type === 'session_progress') listener({ type: 'progress', progress: event.progress });
      });
      return () => {
        stopSnapshots();
        stopEvents();
      };
    },
    async dispose() {
      // The upstream connection belongs to this hold, so both go together and
      // the session server sees the detach it is waiting for.
      await lease.dispose().catch(() => undefined);
      await client.dispose().catch(() => undefined);
    },
  };
}

/**
 * The cockpit's own protocol server, backed by every running session.
 *
 * Each session already serves the protocol on its own socket, so the hub does
 * not reinterpret any of it: it lists what the registry knows and dials the
 * session a browser asks for. That keeps one vocabulary from the agent all the
 * way to the page.
 */
export function createPiHubService(options: PiHubServiceOptions): PiServerService {
  const find = (sessionId: string): SessionRecord => {
    const record = options.records().find((candidate) => candidate.id === sessionId);
    if (!record) throw new PiServerError('not_found', `No session ${sessionId}`);
    return record;
  };

  const open = async (record: SessionRecord): Promise<PiSessionRuntime> => {
    if (!record.protocolSocketPath) {
      throw new PiServerError('not_implemented', `Session ${record.id} predates the protocol socket`);
    }
    const client = new PiClient({
      transportFactory: createUnixTransportFactory({ path: record.protocolSocketPath }),
      onListenerError: (error) => options.onNotice?.(`session ${record.id} listener error: ${error.message}`),
    });
    await client.connect();
    try {
      return leaseRuntime(client, await client.attachSession(record.id));
    } catch (error) {
      await client.dispose().catch(() => undefined);
      throw error;
    }
  };

  return {
    listSessions: async () => options.records().map(toMetadata),
    listModels: async (): Promise<ModelMetadata[]> => [],

    async createSession(create: CreateSessionOptions) {
      if (!create.cwd) throw new PiServerError('invalid_request', 'A new session needs a working directory');
      const outcome = await options.spawn({ cwd: create.cwd, ...(create.name ? { name: create.name } : {}) });
      if (!outcome.ok) {
        throw new PiServerError(outcome.code === 'invalid_request' ? 'invalid_request' : 'not_found', outcome.error);
      }
      // The spawner returns once the record lands, but the session's protocol
      // socket is published a moment later; waiting here spares the caller a
      // retry loop it has no way to bound.
      const deadline = Date.now() + CREATE_TIMEOUT_MS;
      for (;;) {
        const record = options.records().find((candidate) => candidate.id === outcome.sessionId);
        if (record?.protocolSocketPath) return open(record);
        if (Date.now() >= deadline) {
          throw new PiServerError('not_found', `Session ${outcome.sessionId} never published a protocol socket`);
        }
        await new Promise((resolve) => setTimeout(resolve, CREATE_POLL_MS));
      }
    },

    openSession: async (sessionId: string) => open(find(sessionId)),
  };
}
