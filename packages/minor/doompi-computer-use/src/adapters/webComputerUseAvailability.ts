import { API_BASE_PATH } from '../types/computerUseApi.ts';

export class MissingComputerUseApiError extends Error {}

export function computerUseSessionApiError(status: number, value: unknown): Error {
  const error =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).error
      : undefined;
  const message = typeof error === 'string' ? error : `HTTP ${String(status)}`;
  return status === 404 && message === `No API '${API_BASE_PATH}' in this session.`
    ? new MissingComputerUseApiError(message)
    : new Error(message);
}

export function missingComputerUseApiRetryAt(now: number): number {
  return now + 5_000;
}
