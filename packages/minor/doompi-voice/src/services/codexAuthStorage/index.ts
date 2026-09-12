/*
 * Portions of this file are adapted from OpenAI Codex at commit 5ecb3afd1b.
 * Copyright OpenAI. Licensed under the Apache License, Version 2.0.
 */

import {
  assertSize,
  CodexRealtimeAuthError,
  isAbort,
  isRecord,
  MAX_CODEX_AUTH_DOCUMENT_BYTES,
  type CodexAuthTransaction,
  type CodexOwnedAuthStorage,
} from '../codexAuth';

const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_LOCK_ATTEMPTS = 100;
const DEFAULT_LOCK_RETRY_MS = 50;
const CLEANUP_TIMEOUT_MS = 5_000;

export interface DoomPiAuthFileIo {
  readFile(path: string, encoding: 'utf8', signal: AbortSignal): Promise<string>;
  writeFile(path: string, data: string, options: { flag: 'wx'; mode: number; signal: AbortSignal }): Promise<void>;
  rename(from: string, to: string, signal: AbortSignal): Promise<void>;
  unlink(path: string, signal: AbortSignal): Promise<void>;
  /** Must atomically fail with EEXIST when another process owns this directory. */
  mkdir(path: string, signal: AbortSignal): Promise<void>;
  rmdir(path: string, signal: AbortSignal): Promise<void>;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

/**
 * Creates DoomPi's dedicated file store. The lock directory, not a pre-rename
 * check, serializes refresh and login commits across processes.
 */
export function createDoomPiCodexFileAuthStorage(options: {
  authFilePath: string;
  lockPath: string;
  temporaryPath: () => string;
  io: DoomPiAuthFileIo;
  lockAttempts?: number;
  lockRetryMs?: number;
}): CodexOwnedAuthStorage {
  const read = async (signal: AbortSignal): Promise<string | null> => {
    signal.throwIfAborted();
    try {
      const value = await options.io.readFile(options.authFilePath, 'utf8', signal);
      signal.throwIfAborted();
      assertSize(value, MAX_CODEX_AUTH_DOCUMENT_BYTES, 'auth_document_too_large', 'DoomPi auth document is too large.');
      return value;
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return null;
      if (error instanceof CodexRealtimeAuthError || isAbort(error)) throw error;
      throw new CodexRealtimeAuthError('auth_storage_read_failed', 'Could not read DoomPi authentication storage.');
    }
  };

  return {
    read,
    async runExclusive(signal, operation) {
      const attempts = options.lockAttempts ?? DEFAULT_LOCK_ATTEMPTS;
      const retryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
      if (!Number.isSafeInteger(attempts) || attempts <= 0 || !Number.isSafeInteger(retryMs) || retryMs < 0)
        throw new CodexRealtimeAuthError('auth_lock_options_invalid', 'DoomPi auth lock options are invalid.');
      let acquired = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        signal.throwIfAborted();
        try {
          await options.io.mkdir(options.lockPath, signal);
          acquired = true;
          break;
        } catch (error) {
          if (isAbort(error)) throw error;
          if (!isRecord(error) || error.code !== 'EEXIST')
            throw new CodexRealtimeAuthError('auth_lock_failed', 'Could not acquire the DoomPi authentication lock.');
          if (attempt + 1 < attempts) await options.io.sleep(retryMs, signal);
        }
      }
      if (!acquired)
        throw new CodexRealtimeAuthError('auth_lock_timeout', 'Timed out waiting for the DoomPi authentication lock.');
      const transaction: CodexAuthTransaction = {
        read,
        async write(replacement, writeSignal) {
          writeSignal.throwIfAborted();
          assertSize(
            replacement,
            MAX_CODEX_AUTH_DOCUMENT_BYTES,
            'auth_document_too_large',
            'DoomPi auth document is too large.',
          );
          const temporaryPath = options.temporaryPath();
          let created = false;
          try {
            await options.io.writeFile(temporaryPath, replacement, {
              flag: 'wx',
              mode: PRIVATE_FILE_MODE,
              signal: writeSignal,
            });
            created = true;
            writeSignal.throwIfAborted();
            await options.io.rename(temporaryPath, options.authFilePath, writeSignal);
          } catch (error) {
            if (isAbort(error)) throw error;
            throw new CodexRealtimeAuthError(
              'auth_storage_write_failed',
              'Could not update DoomPi authentication storage.',
            );
          } finally {
            if (created)
              await options.io.unlink(temporaryPath, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(() => undefined);
          }
        },
      };
      const outcome = await Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return operation(transaction);
        })
        .then(
          (value) => ({ ok: true, value }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        );
      try {
        await options.io.rmdir(options.lockPath, AbortSignal.timeout(CLEANUP_TIMEOUT_MS));
      } catch {
        throw new CodexRealtimeAuthError(
          'auth_lock_release_failed',
          'Could not release the DoomPi authentication lock.',
        );
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
  };
}
