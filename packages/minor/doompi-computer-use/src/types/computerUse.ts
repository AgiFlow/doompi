export const COMPUTER_USE_PHASES = [
  'inactive',
  'requesting',
  'awaiting_confirmation',
  'activating',
  'active',
  'stopping',
  'failed',
] as const;

export type ComputerUsePhase = (typeof COMPUTER_USE_PHASES)[number];

export interface ComputerUseSessionIdentity {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly modeEpoch: string;
}

export interface ComputerUseTarget {
  readonly bundleId: string;
  readonly applicationName: string;
  readonly processId: number;
  readonly windowId: string;
  readonly windowTitle: string;
}

export interface ComputerUseGrant {
  readonly runId: string;
  readonly grantId: string;
  readonly hostGeneration: string;
  readonly targetGeneration: string;
  readonly expiresAt: number;
}

export interface ComputerUseElement {
  readonly ref: string;
  readonly role: string;
  readonly label?: string;
  readonly enabled: boolean;
  readonly secure: boolean;
  readonly actions: readonly ComputerUseActionKind[];
}

export interface ComputerUseObservation {
  readonly runId: string;
  readonly snapshotId: string;
  readonly targetGeneration: string;
  readonly applicationName: string;
  readonly bundleId: string;
  readonly windowTitle: string;
  readonly elements: readonly ComputerUseElement[];
  readonly screenshot: {
    readonly mimeType: 'image/png';
    readonly data: string;
  };
}

export type ComputerUseActionKind = 'press' | 'set_value' | 'scroll';

export type ComputerUseAction =
  | {
      readonly kind: 'press';
      readonly snapshotId: string;
      readonly elementRef: string;
    }
  | {
      readonly kind: 'set_value';
      readonly snapshotId: string;
      readonly elementRef: string;
      readonly value: string;
    }
  | {
      readonly kind: 'scroll';
      readonly snapshotId: string;
      readonly elementRef: string;
      readonly direction: 'up' | 'down' | 'left' | 'right';
      readonly amount: 'line' | 'page';
    };

export type ComputerUseFailureCode =
  | 'busy_in_another_session'
  | 'desktop_unavailable'
  | 'permission_required_on_mac'
  | 'confirmation_denied'
  | 'confirmation_expired'
  | 'target_invalid'
  | 'target_lost'
  | 'recording_failed'
  | 'trace_failed'
  | 'grant_expired'
  | 'stale_request'
  | 'outcome_uncertain'
  | 'internal_error';

export interface ComputerUseState {
  readonly revision: number;
  readonly phase: ComputerUsePhase;
  readonly identity: ComputerUseSessionIdentity;
  readonly requestId?: string;
  readonly target?: ComputerUseTarget;
  readonly grant?: ComputerUseGrant;
  readonly failure?: {
    readonly code: ComputerUseFailureCode;
    readonly message: string;
  };
}

export type ComputerUseStateEvent =
  | { readonly type: 'request'; readonly requestId: string; readonly target: ComputerUseTarget }
  | { readonly type: 'await_confirmation'; readonly requestId: string }
  | { readonly type: 'confirm'; readonly requestId: string }
  | { readonly type: 'deny'; readonly requestId: string }
  | { readonly type: 'activated'; readonly requestId: string; readonly grant: ComputerUseGrant }
  | { readonly type: 'stop' }
  | { readonly type: 'stopped' }
  | { readonly type: 'fail'; readonly code: ComputerUseFailureCode; readonly message: string }
  | { readonly type: 'reset' };
