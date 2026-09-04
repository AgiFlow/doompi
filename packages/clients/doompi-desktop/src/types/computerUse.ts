export const COMPUTER_USE_IPC_VERSION = 1;
export const COMPUTER_USE_IPC_REQUEST = 'doompi:computer-use:request';
export const COMPUTER_USE_IPC_RESPONSE = 'doompi:computer-use:response';
export const COMPUTER_USE_IPC_CANCEL = 'doompi:computer-use:cancel';
export const COMPUTER_USE_MAX_IPC_BYTES = 8 * 1024 * 1024;

export type ComputerUseDesktopOperation = 'status' | 'targets' | 'activate' | 'observe' | 'act' | 'stop';

export interface ComputerUseDesktopRequest {
  readonly type: typeof COMPUTER_USE_IPC_REQUEST;
  readonly version: typeof COMPUTER_USE_IPC_VERSION;
  readonly requestId: string;
  readonly sessionId: string;
  readonly operation: ComputerUseDesktopOperation;
  readonly payload?: unknown;
}

export type ComputerUseDesktopResponse =
  | {
      readonly type: typeof COMPUTER_USE_IPC_RESPONSE;
      readonly version: typeof COMPUTER_USE_IPC_VERSION;
      readonly requestId: string;
      readonly hostGeneration: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly type: typeof COMPUTER_USE_IPC_RESPONSE;
      readonly version: typeof COMPUTER_USE_IPC_VERSION;
      readonly requestId: string;
      readonly hostGeneration: string;
      readonly ok: false;
      readonly error: string;
      readonly code: string;
    };

export interface ComputerUseBackendGrant {
  readonly grantId: string;
  readonly runId: string;
  readonly expiresAt: number;
}

export interface ComputerUseBackend {
  status(): Promise<unknown>;
  targets(): Promise<unknown>;
  activate(input: {
    sessionId: string;
    grantId: string;
    runId: string;
    expiresAt: number;
    payload: unknown;
    signal?: AbortSignal;
  }): Promise<unknown>;
  observe(input: { sessionId: string; grantId: string; payload: unknown; signal?: AbortSignal }): Promise<unknown>;
  act(input: {
    sessionId: string;
    grantId: string;
    sequence: number;
    payload: unknown;
    signal?: AbortSignal;
  }): Promise<unknown>;
  stop(input: { sessionId: string; grantId: string; reason: string }): Promise<void>;
}
