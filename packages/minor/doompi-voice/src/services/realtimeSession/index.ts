import { assign, createActor, setup } from 'xstate';
import type { IClock, TimerHandle } from '../../types';
import {
  REALTIME_LIMITS,
  type RealtimeActionRequest,
  type RealtimeCall,
  type RealtimeCallRequest,
  type RealtimeDeliveryOutcome,
  type RealtimeEvent,
  type RealtimeProvider,
} from '../../types/realtime';
import { parseRealtimeEvent } from '../realtimeProtocol';

export interface RealtimeSessionIdentity {
  sessionId: string;
  activationId: string;
  mediaLeaseId: string;
  connectionId: string;
}

export interface RealtimeSessionOptions {
  identity: RealtimeSessionIdentity;
  provider: RealtimeProvider;
  clock: IClock;
  ownsMedia(identity: Readonly<RealtimeSessionIdentity>): boolean;
  /** Must synchronously stop local transmission and playback, before asynchronous cleanup. */
  stopMedia(): void;
}

const lifecycle = setup({
  types: {
    context: {} as { providerReady: boolean; mediaReady: boolean },
    events: {} as { type: 'START' | 'CREATED' | 'READY' | 'MEDIA_READY' | 'FAIL' | 'CLOSE' },
  },
}).createMachine({
  id: 'realtime',
  initial: 'idle',
  context: { providerReady: false, mediaReady: false },
  on: { CLOSE: '.closed', FAIL: '.failed' },
  states: {
    idle: { on: { START: 'negotiating' } },
    negotiating: { on: { CREATED: 'connecting' } },
    connecting: {
      on: {
        READY: { actions: assign({ providerReady: true }) },
        MEDIA_READY: { actions: assign({ mediaReady: true }) },
      },
      always: { guard: ({ context }) => context.providerReady && context.mediaReady, target: 'active' },
    },
    active: {},
    failed: { type: 'final' },
    closed: { type: 'final' },
  },
});

interface DeliveryRecord {
  text: string;
  result: Promise<RealtimeDeliveryOutcome>;
}

/** One activation only. A new lease or reconnect requires a new instance and explicit activation. */
export class RealtimeSession {
  private readonly actor = createActor(lifecycle).start();
  private readonly controller = new AbortController();
  private readonly identity: Readonly<RealtimeSessionIdentity>;
  private readonly deliveries = new Map<string, DeliveryRecord>();
  private delivering = false;
  private connectionDeadline: TimerHandle | undefined;

  public constructor(private readonly options: RealtimeSessionOptions) {
    this.identity = Object.freeze({ ...options.identity });
  }

  public get state(): 'idle' | 'negotiating' | 'connecting' | 'active' | 'failed' | 'closed' {
    return this.actor.getSnapshot().value;
  }

  public async negotiate(identity: RealtimeSessionIdentity, request: RealtimeCallRequest): Promise<RealtimeCall> {
    if (!this.current(identity) || this.state !== 'idle') throw new Error('Realtime activation is unavailable.');
    this.actor.send({ type: 'START' });
    try {
      const call = await this.bounded(() => this.options.provider.createCall(request, this.controller.signal));
      if (!this.current(identity)) throw new Error('Realtime activation ended.');
      this.actor.send({ type: 'CREATED' });
      this.connectionDeadline = this.options.clock.setTimeout(() => this.end('FAIL'), 15_000);
      return call;
    } catch {
      this.end('FAIL');
      throw new Error('Realtime negotiation failed.');
    }
  }

  public mediaFailed(identity: RealtimeSessionIdentity): void {
    if (this.current(identity)) this.end('FAIL');
  }

  public mediaConnected(identity: RealtimeSessionIdentity): void {
    if (this.current(identity)) this.actor.send({ type: 'MEDIA_READY' });
    if (this.state === 'active') this.clearConnectionDeadline();
  }

  /** Returns bounded data only. Delegations never invoke an agent or a tool here. */
  public receive(identity: RealtimeSessionIdentity, raw: string): RealtimeEvent | undefined {
    if (!this.current(identity) || (this.state !== 'connecting' && this.state !== 'active')) return undefined;
    const event = parseRealtimeEvent(raw);
    if (event?.type === 'error') this.end('FAIL');
    else if (event?.type === 'ready') this.actor.send({ type: 'READY' });
    if (this.state === 'active') this.clearConnectionDeadline();
    return event;
  }

  /** The caller must validate fresh user intent and approvals before requesting delivery. */
  public submit(
    identity: RealtimeSessionIdentity,
    request: RealtimeActionRequest,
    deliver: (request: Readonly<RealtimeActionRequest>) => void | Promise<void>,
  ): Promise<RealtimeDeliveryOutcome> {
    if (
      !this.current(identity) ||
      this.state !== 'active' ||
      request.activationId !== this.identity.activationId ||
      !request.requestId ||
      request.requestId.length > REALTIME_LIMITS.identifierCharacters ||
      !request.text.trim() ||
      request.text.length > REALTIME_LIMITS.textCharacters
    )
      return Promise.resolve('rejected');
    const existing = this.deliveries.get(request.requestId);
    if (existing) return existing.text === request.text ? existing.result : Promise.resolve('rejected');
    if (this.deliveries.size >= REALTIME_LIMITS.retainedRequests) return Promise.resolve('rejected');
    const captured = Object.freeze({ ...request });
    if (this.delivering) {
      const result = Promise.resolve<RealtimeDeliveryOutcome>('busy');
      this.deliveries.set(captured.requestId, { text: captured.text, result });
      return result;
    }
    this.delivering = true;
    // Defer invocation until the identity and deduplication record are installed.
    const result = Promise.resolve().then(async (): Promise<RealtimeDeliveryOutcome> => {
      if (!this.current(identity)) return 'rejected';
      try {
        await this.bounded(() => deliver(captured));
        this.delivering = false;
        return this.current(identity) ? 'submitted' : 'uncertain';
      } catch {
        // The void delivery port cannot prove cancellation. Retain the occupied slot.
        return 'uncertain';
      }
    });
    this.deliveries.set(captured.requestId, { text: captured.text, result });
    return result;
  }

  public close(): void {
    this.end('CLOSE');
  }

  /** Call from the media/control lease watchdog, not only when provider events arrive. */
  public checkOwnership(): boolean {
    return this.current(this.identity);
  }

  private current(identity: Readonly<RealtimeSessionIdentity>): boolean {
    if (this.controller.signal.aborted || this.actor.getSnapshot().status === 'done') return false;
    if (
      identity.sessionId !== this.identity.sessionId ||
      identity.activationId !== this.identity.activationId ||
      identity.mediaLeaseId !== this.identity.mediaLeaseId ||
      identity.connectionId !== this.identity.connectionId
    )
      return false;
    if (!this.options.ownsMedia(this.identity)) {
      this.end('CLOSE');
      return false;
    }
    return true;
  }

  private clearConnectionDeadline(): void {
    if (this.connectionDeadline !== undefined) this.options.clock.clear(this.connectionDeadline);
    this.connectionDeadline = undefined;
  }

  private end(type: 'CLOSE' | 'FAIL'): void {
    if (this.controller.signal.aborted || this.actor.getSnapshot().status === 'done') return;
    this.actor.send({ type });
    this.deliveries.clear();
    this.clearConnectionDeadline();
    try {
      this.options.stopMedia();
    } finally {
      this.controller.abort();
    }
  }

  private bounded<T>(operation: () => T | Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.options.clock.clear(timer);
        signal.removeEventListener('abort', aborted);
        callback();
      };
      const aborted = (): void => finish(() => reject(new Error('Realtime operation cancelled.')));
      const timer = this.options.clock.setTimeout(
        () => finish(() => reject(new Error('Realtime operation timed out.'))),
        15_000,
      );
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      Promise.resolve()
        .then(() => {
          if (settled || !this.current(this.identity)) throw new Error('Realtime operation cancelled.');
          return operation();
        })
        .then(
          (value) => finish(() => resolve(value)),
          () => finish(() => reject(new Error('Realtime operation failed.'))),
        );
    });
  }
}
