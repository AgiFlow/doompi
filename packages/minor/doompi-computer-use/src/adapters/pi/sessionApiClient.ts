import type { ComputerUseAction, ComputerUseObservation } from '../../types/computerUse.ts';
import type { ComputerUseSessionView } from '../../types/computerUseApi.ts';

export interface ComputerUseSessionClient {
  state(signal?: AbortSignal): Promise<ComputerUseSessionView>;
  /** Subscribes to lifecycle-owned state changes, without polling the session API. */
  subscribeStatus?(listener: (state: ComputerUseSessionView) => void): () => void;
  observe(signal?: AbortSignal): Promise<ComputerUseObservation>;
  act(action: ComputerUseAction, signal?: AbortSignal): Promise<unknown>;
  stop(signal?: AbortSignal): Promise<ComputerUseSessionView>;
}

/** Uses the host-owned typed service directly. Internal package APIs are in-process. */
export function createComputerUseSessionClient(host?: ComputerUseSessionClient): ComputerUseSessionClient | undefined {
  return host;
}
