import type { VoiceWorkerEvent } from './voiceWorkerProtocol.ts';
import { parseVoiceWorkerEvent } from './voiceWorkerProtocol.ts';

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 4_000;
const DEFAULT_HEARTBEAT_CHECK_MS = 1_000;
const DEFAULT_MAX_RESTARTS = 3;

export interface VoiceWorkerHandle {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
  unref(): void;
}

export interface VoiceWorkerSupervisorOptions {
  createWorker: () => VoiceWorkerHandle;
  onEvent: (event: VoiceWorkerEvent) => void;
  onSpawn?: () => void;
  onRestart?: (reason: 'error' | 'exit' | 'heartbeat') => void;
  onExhausted?: (reason: 'error' | 'exit' | 'heartbeat') => void;
  heartbeatTimeoutMs?: number;
  heartbeatCheckMs?: number;
  maxRestarts?: number;
  now?: () => number;
}

export class VoiceWorkerSupervisor {
  private readonly options: VoiceWorkerSupervisorOptions;
  private readonly now: () => number;
  private worker: VoiceWorkerHandle | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private restarts = 0;
  private lastHeartbeatAt = 0;
  private stopping = false;

  public constructor(options: VoiceWorkerSupervisorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  public start(): void {
    if (this.worker) return;
    this.stopping = false;
    this.spawn();
    const checkMs = this.options.heartbeatCheckMs ?? DEFAULT_HEARTBEAT_CHECK_MS;
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), checkMs);
    this.heartbeatTimer.unref();
  }

  public postMessage(value: unknown): void {
    if (!this.worker) throw new Error('Voice worker is not running.');
    this.worker.postMessage(value);
  }

  public async stop(): Promise<void> {
    const worker = this.beginStop();
    if (worker) await worker.terminate();
  }

  public async stopGracefully(timeoutMs: number): Promise<void> {
    const worker = this.beginStop();
    if (!worker) return;
    if (timeoutMs <= 0) {
      await worker.terminate();
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<boolean>((resolve) => worker.on('exit', () => resolve(true)));
    const expired = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref();
    });
    const exitedGracefully = await Promise.race([exited, expired]);
    if (timeout) clearTimeout(timeout);
    if (!exitedGracefully) await worker.terminate();
  }

  private beginStop(): VoiceWorkerHandle | undefined {
    this.stopping = true;
    this.generation += 1;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const worker = this.worker;
    this.worker = undefined;
    return worker;
  }

  private spawn(): void {
    const worker = this.options.createWorker();
    const generation = this.generation + 1;
    this.generation = generation;
    this.worker = worker;
    this.lastHeartbeatAt = this.now();
    let lastEventSequence = -1;

    worker.on('message', (value) => {
      if (generation !== this.generation || this.stopping) return;
      let event: VoiceWorkerEvent;
      try {
        event = parseVoiceWorkerEvent(value);
      } catch {
        this.restart('error', generation);
        return;
      }
      if (event.sequence <= lastEventSequence) {
        this.restart('error', generation);
        return;
      }
      lastEventSequence = event.sequence;
      if (event.kind === 'heartbeat' || event.kind === 'ready') {
        this.lastHeartbeatAt = this.now();
        if (event.kind === 'ready') this.restarts = 0;
      }
      this.options.onEvent(event);
    });
    worker.on('error', () => this.restart('error', generation));
    worker.on('exit', () => this.restart('exit', generation));
    worker.unref();
    this.options.onSpawn?.();
  }

  private checkHeartbeat(): void {
    if (!this.worker || this.stopping) return;
    const timeoutMs = this.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    if (this.now() - this.lastHeartbeatAt > timeoutMs) this.restart('heartbeat', this.generation);
  }

  private restart(reason: 'error' | 'exit' | 'heartbeat', generation: number): void {
    if (this.stopping || generation !== this.generation) return;
    const previous = this.worker;
    this.worker = undefined;
    this.generation += 1;
    if (previous) void previous.terminate();

    const maxRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    if (this.restarts >= maxRestarts) {
      this.options.onExhausted?.(reason);
      return;
    }
    this.restarts += 1;
    this.options.onRestart?.(reason);
    this.spawn();
  }
}
