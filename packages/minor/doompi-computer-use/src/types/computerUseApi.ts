import type { DoomApiCaller } from '@agimon-ai/doompi-extension-contracts/package-api';

export const API_BASE_PATH = 'computer-use';
export const computerUseChannelType = 'computer_use_state';
export const SESSION_QUERY_PARAM = 'session';
export const COMPUTER_USE_MAX_DURATION_MS = 1_800 * 1_000;
export const COMPUTER_USE_DEFAULT_DURATION_MS = 300 * 1_000;
export const COMPUTER_USE_CONFIRMATION_WINDOW_MS = 2 * 60 * 1_000;

export function activationUrl(sessionId: string): string {
  return `/api/plugin/${API_BASE_PATH}/activate?${SESSION_QUERY_PARAM}=${encodeURIComponent(sessionId)}`;
}

export const COMPUTER_USE_ROUTES = {
  activate: '/activate',
  agentState: '/agent/state',
  agentObserve: '/agent/observe',
  agentAction: '/agent/action',
  agentStop: '/agent/stop',
  hubState: '/hub/state',
  hubActivation: '/hub/activation',
  hubAuthorization: '/hub/authorization',
  hubNext: '/hub/next',
  hubComplete: '/hub/complete',
  hubStop: '/hub/stop',
} as const;

export const COMPUTER_USE_WAKE_LIMIT = 1_000_000;

export interface ComputerUseArtifactView {
  readonly artifactId: string;
  readonly status: 'ready' | 'failed';
  readonly downloadUrl?: string;
  readonly previewUrl?: string;
  readonly actionCount?: number;
  readonly completedAt?: string;
}

export interface ComputerUseSessionView {
  readonly sessionId: string;
  readonly revision: number;
  readonly wake: number;
  readonly phase: 'inactive' | 'awaiting_confirmation' | 'activating' | 'active' | 'stopping' | 'failed';
  readonly requestId?: string;
  readonly target?: Record<string, unknown>;
  readonly durationMs?: number;
  readonly expiresAt?: number;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly artifact?: ComputerUseArtifactView;
}

export interface ComputerUseActivationRequest {
  readonly requestId: string;
  readonly target: Record<string, unknown>;
  readonly durationSeconds: number;
  readonly createdAt: number;
  readonly confirmationExpiresAt: number;
  readonly caller: DoomApiCaller;
}

export interface ComputerUseBrokerRequest {
  readonly id: string;
  readonly operation: 'observe' | 'act';
  readonly payload?: unknown;
  readonly grantId: string;
  readonly sequence?: number;
}

export interface ComputerUseChannelPayload {
  readonly state: ComputerUseSessionView;
  readonly targets: readonly Record<string, unknown>[];
  readonly busy?: true;
}

export type ComputerUseBrowserCommand = { readonly action: 'status' | 'targets' | 'stop' | 'artifacts' };
