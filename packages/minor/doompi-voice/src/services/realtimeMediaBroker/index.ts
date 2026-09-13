import type { IClock, TimerHandle } from '../../types';
import type {
  RealtimeBrowserState,
  RealtimeControl,
  RealtimeHostSnapshot,
  RealtimeMediaCommand,
  RealtimeProvider,
} from '../../types/realtime';
import { RealtimeSession, type RealtimeSessionIdentity } from '../realtimeSession';

type Command = RealtimeMediaCommand extends infer Event
  ? Event extends RealtimeMediaCommand
    ? Omit<Event, 'sequence'>
    : never
  : never;

export interface RealtimeMediaBrokerOptions {
  identity: RealtimeSessionIdentity;
  instructions: string;
  provider: RealtimeProvider;
  clock: IClock;
  ownsMedia(): boolean;
  publish(command: Command): void;
}

/** A single host-authorized activation beneath the existing media lease. */
export class RealtimeMediaBroker {
  private readonly session: RealtimeSession;
  private readonly events: RealtimeHostSnapshot['events'] = [];
  private sequence = 0;
  private browser: RealtimeBrowserState | undefined;
  private lastHostPoll: number;
  private watchdog: TimerHandle | undefined;
  private watchdogGeneration = 0;

  private static readonly WATCHDOG_INTERVAL_MS = 1_000;
  public constructor(private readonly options: RealtimeMediaBrokerOptions) {
    this.lastHostPoll = options.clock.now();
    this.session = new RealtimeSession({
      identity: options.identity,
      provider: options.provider,
      clock: options.clock,
      ownsMedia: () => options.ownsMedia() && options.clock.now() - this.lastHostPoll <= 10_000,
      stopMedia: () => options.publish({ type: 'realtime-stop', activationId: this.activationId }),
    });
    const generation = ++this.watchdogGeneration;
    this.watchdog = options.clock.setInterval(() => {
      if (generation !== this.watchdogGeneration) return;
      this.check();
    }, RealtimeMediaBroker.WATCHDOG_INTERVAL_MS);
  }

  public get activationId(): string {
    return this.options.identity.activationId;
  }
  public get active(): boolean {
    return this.session.state !== 'failed' && this.session.state !== 'closed';
  }

  public start(): void {
    this.options.publish({ type: 'realtime-start', activationId: this.activationId });
  }

  public check(): void {
    if (!this.active) {
      this.clearWatchdog();
      return;
    }
    this.session.checkOwnership();
    if (!this.active) this.clearWatchdog();
  }

  public async negotiate(sdp: string): Promise<string> {
    try {
      const call = await this.session.negotiate(this.options.identity, {
        sdp,
        instructions: this.options.instructions,
      });
      return call.sdp;
    } finally {
      if (!this.active) this.clearWatchdog();
    }
  }

  public receive(raw: string): void {
    const event = this.session.receive(this.options.identity, raw);
    if (!this.active) this.clearWatchdog();
    if (event === undefined) return;
    this.events.push({ sequence: ++this.sequence, event });
    if (this.events.length > 64) this.events.shift();
  }

  public updateBrowser(state: RealtimeBrowserState): void {
    this.check();
    // Terminal browser reports acknowledge physical local cleanup even after host closure.
    if (!this.active && state.connection !== 'closed' && state.connection !== 'failed') return;
    this.browser = { ...state };
    if (state.connection === 'failed') this.session.mediaFailed(this.options.identity);
    else if (state.connection === 'closed') this.close();
    else if (state.connection === 'connected') this.session.mediaConnected(this.options.identity);
    if (!this.active) this.clearWatchdog();
  }

  public poll(after: number): RealtimeHostSnapshot {
    this.check();
    if (after > this.sequence || (this.events.length > 0 && after < this.events[0]!.sequence - 1)) {
      this.close();
      throw new Error('Live voice event gap. Start a fresh activation.');
    }
    this.lastHostPoll = this.options.clock.now();
    const state = this.session.state;
    return {
      activationId: this.activationId,
      state: state === 'idle' || state === 'negotiating' ? 'connecting' : state,
      cursor: this.sequence,
      events: this.events.filter((entry) => entry.sequence > after),
      ...(this.browser === undefined ? {} : { browser: { ...this.browser } }),
    };
  }

  public send(messages: string[]): void {
    this.check();
    if (this.session.state !== 'active') throw new Error('Live voice is not connected.');
    this.options.publish({ type: 'realtime-send', activationId: this.activationId, messages });
  }

  public control(action: RealtimeControl): void {
    this.check();
    if (!this.active) throw new Error('Live voice is not active.');
    this.options.publish({ type: 'realtime-control', activationId: this.activationId, action });
  }

  public close(): void {
    this.clearWatchdog();
    this.session.close();
    this.events.length = 0;
    // Do not invent a browser playback/capture outcome before its terminal report.
  }

  private clearWatchdog(): void {
    this.watchdogGeneration += 1;
    if (this.watchdog !== undefined) this.options.clock.clear(this.watchdog);
    this.watchdog = undefined;
  }
}
