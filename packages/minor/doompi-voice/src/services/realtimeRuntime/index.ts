import { constants, promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import type { RealtimeAuth, RealtimeProvider } from '../../types/realtime';
import { CodexRealtimeAuthError, createCodexRealtimeAuth, isRecord } from '../codexAuth';
import { createDoomPiCodexFileAuthStorage, type DoomPiAuthFileIo } from '../codexAuthStorage';
import { createCodexLogin } from '../codexLogin';
import { createCodexRealtimeProvider } from '../codexRealtime';

const CALLBACK_HOST = 'localhost';
const CALLBACK_PATH = '/auth/callback';
const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_LOGIN_TIMEOUT_MS = 10 * 60_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const TRANSACTION_CLEANUP_TIMEOUT_MS = 5_000;

export interface RealtimeSignInAttempt {
  readonly authorizationUrl: string;
  readonly completion: Promise<void>;
  cancel(): void;
}

export interface RealtimeRuntime {
  readonly auth: RealtimeAuth;
  readonly provider: RealtimeProvider;
  signIn(signal?: AbortSignal): Promise<RealtimeSignInAttempt>;
}

export interface RealtimeRuntimeOptions {
  /** An explicitly selected DoomPi-owned state directory. */
  stateDirectory: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  operationTimeoutMs?: number;
  loginTimeoutMs?: number;
  callbackPort?: number;
  realtimeDeadlineMs?: number;
  lockAttempts?: number;
  lockRetryMs?: number;
}

/** Composes the host-only subscription runtime without reading credentials, opening a browser, or listening. */
export function createRealtimeRuntime(options: RealtimeRuntimeOptions): RealtimeRuntime {
  assertOptions(options);
  const sourceFetch: typeof globalThis.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const fetchImpl: typeof globalThis.fetch = (input, init) => fetchWithAbort(sourceFetch, input, init);
  const now = options.now ?? (() => new Date());
  const authDirectory = join(options.stateDirectory, 'voice', 'subscription-auth');
  const authFilePath = join(authDirectory, 'auth.json');
  const lockPath = join(authDirectory, 'auth.lock');
  let directoryReady: Promise<void> | undefined;
  const pendingTransactions = new Set<Promise<void>>();

  const ensureDirectory = (): Promise<void> => {
    directoryReady ??= ensurePrivateDirectory(authDirectory).catch((error: unknown) => {
      directoryReady = undefined;
      throw error;
    });
    return directoryReady;
  };
  const fileStorage = createDoomPiCodexFileAuthStorage({
    authFilePath,
    lockPath,
    temporaryPath: () => join(authDirectory, `.auth.${process.pid}.${randomBytes(16).toString('hex')}.tmp`),
    io: nodeAuthFileIo,
    lockAttempts: options.lockAttempts,
    lockRetryMs: options.lockRetryMs,
  });
  const storage = {
    async read(signal: AbortSignal) {
      await ensureDirectory();
      return fileStorage.read(signal);
    },
    async runExclusive<T>(
      signal: AbortSignal,
      operation: Parameters<typeof fileStorage.runExclusive<T>>[1],
    ): Promise<T> {
      await ensureDirectory();
      signal.throwIfAborted();
      let transactionFinished!: () => void;
      const pending = new Promise<void>((resolve) => (transactionFinished = resolve));
      pendingTransactions.add(pending);
      try {
        return await fileStorage.runExclusive(signal, operation);
      } finally {
        transactionFinished();
        pendingTransactions.delete(pending);
      }
    },
  };
  const composedAuth = createCodexRealtimeAuth({
    storage,
    fetch: fetchImpl,
    now,
    operationTimeoutMs: options.operationTimeoutMs,
  });
  const auth: RealtimeAuth = {
    credentials: (signal) => composedAuth.credentials(signal),
    async refresh(signal) {
      try {
        return await composedAuth.refresh(signal);
      } catch (error) {
        await awaitTransactionCleanup(pendingTransactions);
        throw error;
      }
    },
  };
  const provider = createCodexRealtimeProvider({
    auth,
    fetch: fetchImpl,
    deadlineMs: options.realtimeDeadlineMs,
  });
  const login = createCodexLogin({
    storage,
    fetch: fetchImpl,
    randomBytes: (length) => randomBytes(length),
    now,
    operationTimeoutMs: options.operationTimeoutMs,
  });

  return {
    auth,
    provider,
    async signIn(signal = new AbortController().signal) {
      signal.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
      const cancellation = new AbortController();
      const boundedSignal = AbortSignal.any([signal, cancellation.signal, timeoutSignal]);
      const server = createServer();
      const port = await listen(server, options.callbackPort ?? DEFAULT_CALLBACK_PORT, boundedSignal);
      const redirectUri = `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;
      let attempt;
      try {
        attempt = login.begin(redirectUri);
      } catch (error) {
        await closeServer(server);
        throw error;
      }
      const expectedState = new URL(attempt.authorizationUrl).searchParams.get('state')!;
      let settled = false;
      let handling = false;
      let resolveCompletion!: () => void;
      let rejectCompletion!: (error: unknown) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      const finish = async (error?: unknown): Promise<void> => {
        if (settled) return;
        settled = true;
        boundedSignal.removeEventListener('abort', onAbort);
        await closeServer(server);
        await awaitTransactionCleanup(pendingTransactions);
        if (error === undefined) resolveCompletion();
        else rejectCompletion(error);
      };
      const onAbort = (): void => {
        const error = timeoutSignal.aborted
          ? new CodexRealtimeAuthError('login_timeout', 'DoomPi sign-in timed out.')
          : new CodexRealtimeAuthError('login_cancelled', 'DoomPi sign-in was cancelled.');
        void finish(error);
      };
      boundedSignal.addEventListener('abort', onAbort, { once: true });
      server.on('request', (request, response) => {
        void (async () => {
          if (settled || handling) {
            sendCallbackResponse(response, 409, 'Sign-in is no longer accepting callbacks.');
            return;
          }
          const callback = callbackUrl(request.method, request.url, redirectUri);
          if (!callback || !validState(callback, expectedState)) {
            sendCallbackResponse(response, 400, 'Invalid sign-in callback.');
            return;
          }
          handling = true;
          try {
            await attempt.complete(callback.toString(), boundedSignal);
            sendCallbackResponse(response, 200, 'Sign-in complete. You may close this page.');
            await finish();
          } catch (error) {
            if (isRetryableCallbackError(error) && !boundedSignal.aborted) {
              handling = false;
              sendCallbackResponse(response, 400, 'Invalid sign-in callback.');
              return;
            }
            sendCallbackResponse(response, 400, 'Sign-in could not be completed.');
            await finish(redactedLoginError(error, boundedSignal));
          }
        })();
      });
      if (boundedSignal.aborted) onAbort();
      return {
        authorizationUrl: attempt.authorizationUrl,
        completion,
        cancel: () => cancellation.abort(),
      };
    },
  };
}

const nodeAuthFileIo: DoomPiAuthFileIo = {
  async readFile(path, encoding, signal) {
    signal.throwIfAborted();
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Authentication storage is not a regular file.');
      return await handle.readFile({ encoding, signal });
    } finally {
      await handle.close();
    }
  },
  async writeFile(path, data, options) {
    options.signal.throwIfAborted();
    const handle = await fs.open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      options.mode,
    );
    try {
      await handle.writeFile(data, { encoding: 'utf8', signal: options.signal });
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(path).catch(() => undefined);
      throw error;
    }
    try {
      await handle.close();
    } catch (error) {
      await fs.unlink(path).catch(() => undefined);
      throw error;
    }
  },
  async rename(from, to, signal) {
    signal.throwIfAborted();
    await fs.rename(from, to);
  },
  async unlink(path, signal) {
    signal.throwIfAborted();
    await fs.unlink(path);
  },
  async mkdir(path, signal) {
    signal.throwIfAborted();
    await fs.mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  },
  async rmdir(path, signal) {
    signal.throwIfAborted();
    await fs.rmdir(path);
  },
  async sleep(milliseconds, signal) {
    await sleep(milliseconds, undefined, { signal });
  },
};

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a private directory');
    await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
  } catch {
    throw new CodexRealtimeAuthError(
      'auth_storage_initialize_failed',
      'Could not initialize DoomPi authentication storage.',
    );
  }
}

async function fetchWithAbort(
  source: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> {
  const signal = init?.signal;
  if (!signal) return source(input, init);
  signal.throwIfAborted();
  const effect = source(input, init);
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    void effect.then(
      (response) => {
        if (settled) {
          if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
          return;
        }
        settled = true;
        signal.removeEventListener('abort', aborted);
        resolve(response);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}

async function awaitTransactionCleanup(pendingTransactions: Set<Promise<void>>): Promise<void> {
  if (pendingTransactions.size === 0) return;
  const deadline = AbortSignal.timeout(TRANSACTION_CLEANUP_TIMEOUT_MS);
  await Promise.race([
    Promise.all(pendingTransactions),
    new Promise<void>((resolve) => deadline.addEventListener('abort', () => resolve(), { once: true })),
  ]);
}
function assertOptions(options: RealtimeRuntimeOptions): void {
  if (!options.stateDirectory || !isAbsolute(options.stateDirectory))
    throw new CodexRealtimeAuthError('state_directory_invalid', 'DoomPi state directory must be an absolute path.');
  const callbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
  if (!Number.isSafeInteger(callbackPort) || callbackPort < 0 || callbackPort > 65_535)
    throw new CodexRealtimeAuthError('callback_port_invalid', 'OAuth callback port is invalid.');
  const timeout = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_LOGIN_TIMEOUT_MS)
    throw new CodexRealtimeAuthError('login_timeout_invalid', 'DoomPi sign-in timeout is invalid.');
}

function listen(server: Server, port: number, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      cleanup();
      server.close();
      reject(signal.reason);
    };
    const failed = (_error: Error): void => {
      cleanup();
      reject(
        new CodexRealtimeAuthError('callback_listen_failed', 'Could not start the DoomPi sign-in callback listener.'),
      );
      server.close();
    };
    const listening = (): void => {
      cleanup();
      const address = server.address() as AddressInfo;
      resolve(address.port);
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', aborted);
      server.removeListener('error', failed);
      server.removeListener('listening', listening);
    };
    signal.addEventListener('abort', aborted, { once: true });
    server.once('error', failed);
    server.once('listening', listening);
    server.listen({ host: CALLBACK_HOST, port, exclusive: true });
    if (signal.aborted) aborted();
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      server.closeAllConnections();
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function callbackUrl(
  method: string | undefined,
  requestTarget: string | undefined,
  redirectUri: string,
): URL | undefined {
  if (method !== 'GET' || !requestTarget) return undefined;
  try {
    const callback = new URL(requestTarget, redirectUri);
    const redirect = new URL(redirectUri);
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) return undefined;
    return callback;
  } catch {
    return undefined;
  }
}

function validState(callback: URL, expectedState: string): boolean {
  if (callback.searchParams.getAll('state').length !== 1) return false;
  const supplied = Buffer.from(callback.searchParams.get('state') ?? '');
  const expected = Buffer.from(expectedState);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendCallbackResponse(response: import('node:http').ServerResponse, status: number, message: string): void {
  if (response.destroyed) return;
  try {
    response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(message);
  } catch {
    response.destroy();
  }
}

function isRetryableCallbackError(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.code === 'string' &&
    ['callback_invalid', 'state_mismatch', 'authorization_code_missing'].includes(error.code)
  );
}

function redactedLoginError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason;
  if (error instanceof CodexRealtimeAuthError) return error;
  return new CodexRealtimeAuthError('login_failed', 'DoomPi sign-in could not be completed.');
}
