import type { RealtimeControl, RealtimeHostSnapshot } from '../../types/realtime.ts';

export interface RealtimeHost {
  start(activationId: string, instructions: string, signal: AbortSignal): Promise<void>;
  poll(activationId: string, after: number, signal: AbortSignal): Promise<RealtimeHostSnapshot>;
  send(activationId: string, messages: string[], signal: AbortSignal): Promise<void>;
  control(activationId: string, action: RealtimeControl, signal: AbortSignal): Promise<void>;
  stop(activationId: string): Promise<void>;
}

/** Uses the host-owned typed service directly. Browser signaling stays behind that host. */
export function realtimeHostConnection(host?: RealtimeHost): RealtimeHost | undefined {
  return host;
}
