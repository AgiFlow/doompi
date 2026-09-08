/*
 * Portions of this file are ported from OpenAI Codex at commit 5ecb3afd1b.
 * Copyright OpenAI. Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import type { RealtimeAuth, RealtimeCredentials } from '../../types/realtime.ts';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_ORIGIN = 'https://auth.openai.com';
export const CODEX_TOKEN_ENDPOINT = `${CODEX_OAUTH_ORIGIN}/oauth/token`;
export const DOOMPI_AUTH_OWNER = 'doompi';
export const MAX_CODEX_AUTH_DOCUMENT_BYTES = 1_048_576;
export const MAX_CODEX_TOKEN_BYTES = 262_144;
const MAX_REFRESH_RESPONSE_BYTES = 1_048_576;
const KEYRING_SERVICE = 'Codex Auth';
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

export interface CodexAuthStorage {
  read(signal: AbortSignal): Promise<string | null>;
}

export interface CodexAuthTransaction extends CodexAuthStorage {
  write(replacement: string, signal: AbortSignal): Promise<void>;
}

/** A DoomPi-owned store whose lock is exclusive across all instances and processes. */
export interface CodexOwnedAuthStorage extends CodexAuthStorage {
  runExclusive<T>(signal: AbortSignal, operation: (transaction: CodexAuthTransaction) => Promise<T>): Promise<T>;
}

export interface CodexDirectKeyring {
  load(service: string, account: string, signal: AbortSignal): Promise<string | null>;
}

export interface CodexRealtimeAuthOptions {
  storage: CodexOwnedAuthStorage;
  fetch: typeof globalThis.fetch;
  now: () => Date;
  operationTimeoutMs?: number;
}

interface AuthDocument extends Record<string, unknown> {
  auth_mode?: unknown;
  doompi_auth_owner?: unknown;
  tokens?: unknown;
}

interface TokenDocument extends Record<string, unknown> {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
}

interface LoadedAuth {
  raw: string;
  document: AuthDocument;
  tokens: TokenDocument;
  credentials: RealtimeCredentials;
  refreshToken?: string;
}

export class CodexRealtimeAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRealtimeAuthError';
  }
}

/** Creates a host-only adapter for credentials exclusively owned by DoomPi. */
export function createCodexRealtimeAuth(options: CodexRealtimeAuthOptions): RealtimeAuth {
  return {
    async credentials(signal) {
      return withDeadline(signal, options.operationTimeoutMs, async (boundedSignal) => {
        return (await loadAuth(options.storage, boundedSignal, false)).credentials;
      });
    },
    async refresh(signal) {
      return withDeadline(signal, options.operationTimeoutMs, async (boundedSignal) => {
        return options.storage.runExclusive(boundedSignal, (transaction) =>
          refreshLocked(options, transaction, boundedSignal),
        );
      });
    },
  };
}

/** Read-only view of a shared Codex auth file. It can never refresh or replace native credentials. */
export function createCodexFileAuthStorage(options: {
  authFilePath: string;
  readFile(path: string, encoding: 'utf8', signal: AbortSignal): Promise<string>;
}): CodexAuthStorage {
  return {
    async read(signal) {
      signal.throwIfAborted();
      try {
        const value = await options.readFile(options.authFilePath, 'utf8', signal);
        signal.throwIfAborted();
        assertSize(
          value,
          MAX_CODEX_AUTH_DOCUMENT_BYTES,
          'auth_document_too_large',
          'Codex auth document is too large.',
        );
        return value;
      } catch (error) {
        if (isFileNotFound(error)) return null;
        if (error instanceof CodexRealtimeAuthError || isAbort(error)) throw error;
        throw redacted('auth_storage_read_failed', 'Could not read Codex authentication storage.', error);
      }
    },
  };
}

/** Read-only view of Codex's direct native keyring convention. */
export function createCodexDirectKeyringAuthStorage(options: {
  canonicalCodexHome: string;
  keyring: CodexDirectKeyring;
}): CodexAuthStorage {
  const digest = createHash('sha256').update(options.canonicalCodexHome).digest('hex').slice(0, 16);
  const account = `cli|${digest}`;
  return {
    async read(signal) {
      signal.throwIfAborted();
      try {
        const value = await options.keyring.load(KEYRING_SERVICE, account, signal);
        signal.throwIfAborted();
        if (value !== null)
          assertSize(
            value,
            MAX_CODEX_AUTH_DOCUMENT_BYTES,
            'auth_document_too_large',
            'Codex auth document is too large.',
          );
        return value;
      } catch (error) {
        if (error instanceof CodexRealtimeAuthError || isAbort(error)) throw error;
        throw redacted('auth_storage_read_failed', 'Could not read configured Codex keyring storage.', error);
      }
    },
  };
}

async function refreshLocked(
  options: CodexRealtimeAuthOptions,
  storage: CodexAuthTransaction,
  signal: AbortSignal,
): Promise<RealtimeCredentials> {
  const attempted = await loadAuth(storage, signal, true);
  let response: Response;
  try {
    response = await options.fetch(CODEX_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: attempted.refreshToken!,
      }),
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw redacted('refresh_failed', 'Codex token refresh failed.', error);
  }
  rejectRedirect(response, 'refresh_failed', 'Codex token refresh was redirected and rejected.');
  const body = await readBoundedBody(response, signal);
  if (!response.ok) throw refreshFailure(response.status, body);
  const refreshed = parseTokenResponse(body, false);
  const nextTokens: TokenDocument = { ...attempted.tokens };
  if (refreshed.id_token !== undefined) nextTokens.id_token = refreshed.id_token;
  if (refreshed.access_token !== undefined) nextTokens.access_token = refreshed.access_token;
  if (refreshed.refresh_token !== undefined) nextTokens.refresh_token = refreshed.refresh_token;
  const replacement = `${JSON.stringify(
    { ...attempted.document, tokens: nextTokens, last_refresh: options.now().toISOString() },
    null,
    2,
  )}\n`;
  assertSize(
    replacement,
    MAX_CODEX_AUTH_DOCUMENT_BYTES,
    'auth_document_too_large',
    'Codex auth document is too large.',
  );
  await storage.write(replacement, signal);
  return credentialsFromTokens(nextTokens);
}

async function loadAuth(storage: CodexAuthStorage, signal: AbortSignal, requireRefresh: boolean): Promise<LoadedAuth> {
  signal.throwIfAborted();
  let raw: string | null;
  try {
    raw = await storage.read(signal);
  } catch (error) {
    if (error instanceof CodexRealtimeAuthError || isAbort(error)) throw error;
    throw redacted('auth_storage_read_failed', 'Could not read Codex authentication storage.', error);
  }
  if (raw === null)
    throw new CodexRealtimeAuthError('auth_missing', 'DoomPi subscription credentials are not available.');
  assertSize(raw, MAX_CODEX_AUTH_DOCUMENT_BYTES, 'auth_document_too_large', 'Codex auth document is too large.');
  let document: AuthDocument;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('not an object');
    document = parsed;
  } catch (error) {
    throw redacted('auth_document_invalid', 'DoomPi auth storage contains an invalid credential document.', error);
  }
  if (document.doompi_auth_owner !== DOOMPI_AUTH_OWNER)
    throw new CodexRealtimeAuthError('auth_owner_unsupported', 'Credentials are not owned by DoomPi.');
  if (document.auth_mode !== 'chatgpt')
    throw new CodexRealtimeAuthError('auth_mode_unsupported', 'Credentials are not a ChatGPT subscription login.');
  if (!isRecord(document.tokens))
    throw new CodexRealtimeAuthError('auth_tokens_missing', 'Subscription token data is not available.');
  const tokens = document.tokens;
  return {
    raw,
    document,
    tokens,
    credentials: credentialsFromTokens(tokens),
    refreshToken: requireRefresh ? requiredToken(tokens.refresh_token, 'refresh token') : undefined,
  };
}

export function credentialsFromTokens(tokens: Record<string, unknown>): RealtimeCredentials {
  return {
    accessToken: requiredToken(tokens.access_token, 'access token'),
    accountId: requiredToken(tokens.account_id, 'account id'),
  };
}

export function requiredToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    throw new CodexRealtimeAuthError('auth_tokens_invalid', `Subscription ${label} is invalid.`);
  assertSize(value, MAX_CODEX_TOKEN_BYTES, 'auth_token_too_large', `Subscription ${label} is too large.`);
  return value;
}

export function parseJwtPayload(value: string, code = 'auth_tokens_invalid'): Record<string, unknown> {
  requiredToken(value, 'ID token');
  const payload = value.split('.')[1];
  if (!payload) throw new CodexRealtimeAuthError(code, 'Subscription ID token is invalid.');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isRecord(parsed)) throw new Error('payload is not an object');
    return parsed;
  } catch (error) {
    throw redacted(code, 'Subscription ID token is invalid.', error);
  }
}

function parseTokenResponse(body: string, requireAll: boolean): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw redacted('token_response_invalid', 'Codex token endpoint returned an invalid response.', error);
  }
  if (!isRecord(parsed))
    throw new CodexRealtimeAuthError('token_response_invalid', 'Codex token endpoint returned an invalid response.');
  for (const field of ['id_token', 'access_token', 'refresh_token'] as const) {
    if (requireAll || parsed[field] !== undefined) requiredToken(parsed[field], field.replace('_', ' '));
  }
  if (typeof parsed.id_token === 'string') parseJwtPayload(parsed.id_token, 'token_response_invalid');
  return parsed;
}

export async function readCodexTokenResponse(
  response: Response,
  signal: AbortSignal,
  requireAll: boolean,
): Promise<Record<string, unknown>> {
  rejectRedirect(response, 'token_exchange_redirected', 'Codex token exchange was redirected and rejected.');
  const body = await readBoundedBody(response, signal);
  if (!response.ok) throw refreshFailure(response.status, body);
  return parseTokenResponse(body, requireAll);
}

function rejectRedirect(response: Response, code: string, message: string): void {
  if (response.redirected || (response.status >= 300 && response.status < 400))
    throw new CodexRealtimeAuthError(code, message);
  if (response.url) {
    const url = new URL(response.url);
    if (url.origin !== CODEX_OAUTH_ORIGIN) throw new CodexRealtimeAuthError(code, message);
  }
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REFRESH_RESPONSE_BYTES)
    throw new CodexRealtimeAuthError('token_response_too_large', 'Codex token response is too large.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_REFRESH_RESPONSE_BYTES)
        throw new CodexRealtimeAuthError('token_response_too_large', 'Codex token response is too large.');
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged);
}

function refreshFailure(status: number, body: string): CodexRealtimeAuthError {
  let reason: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = parsed.error;
      reason = (
        isRecord(error) && typeof error.code === 'string' ? error.code : typeof error === 'string' ? error : undefined
      )?.toLowerCase();
    }
  } catch {}
  if (reason === 'refresh_token_expired')
    return new CodexRealtimeAuthError(reason, 'Codex refresh token has expired. Sign in again.');
  if (reason === 'refresh_token_reused')
    return new CodexRealtimeAuthError(reason, 'Codex refresh token was already used. Sign in again.');
  if (reason === 'refresh_token_invalidated')
    return new CodexRealtimeAuthError(reason, 'Codex refresh token was revoked. Sign in again.');
  if (status === 401 || (status === 400 && reason === 'invalid_grant'))
    return new CodexRealtimeAuthError('refresh_rejected', 'Codex token request was rejected. Sign in again.');
  return new CodexRealtimeAuthError('token_request_failed', 'Codex token request failed.');
}

export async function withDeadline<T>(
  signal: AbortSignal,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new CodexRealtimeAuthError('timeout_invalid', 'Auth timeout is invalid.');
  signal.throwIfAborted();
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  return abortable(operation(boundedSignal), boundedSignal);
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

export function assertSize(value: string, maximum: number, code: string, message: string): void {
  if (Buffer.byteLength(value, 'utf8') > maximum) throw new CodexRealtimeAuthError(code, message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export function isAbort(error: unknown): boolean {
  return isRecord(error) && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function redacted(code: string, message: string, _cause: unknown): CodexRealtimeAuthError {
  return new CodexRealtimeAuthError(code, message);
}
