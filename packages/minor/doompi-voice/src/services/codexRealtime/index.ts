// Copyright 2025 OpenAI
// SPDX-License-Identifier: Apache-2.0
// Modified for DoomPi from codex-rs realtime call creation.

import type { RealtimeAuth, RealtimeCredentials, RealtimeProvider } from '../../types/realtime';
import { REALTIME_LIMITS } from '../../types/realtime';

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas';
const DEFAULT_CALL_DEADLINE_MS = 15_000;
const MAX_CALL_DEADLINE_MS = 30_000;
const REALTIME_MODEL = 'gpt-live-1-codex';
const REALTIME_VOICE = 'cove';
const ORIGINATOR = 'doompi_voice';
const USER_AGENT = '@agimon-ai/doompi-voice';

export interface CodexRealtimeProviderOptions {
  auth: RealtimeAuth;
  fetch: typeof globalThis.fetch;
  deadlineMs?: number;
}

function assertBoundedRequest(sdp: string, instructions: string): void {
  if (!sdp || new TextEncoder().encode(sdp).byteLength > REALTIME_LIMITS.sdpBytes) {
    throw new Error('Realtime call SDP is empty or exceeds the configured limit.');
  }
  if (instructions.length > REALTIME_LIMITS.instructionsCharacters) {
    throw new Error('Realtime call instructions exceed the configured limit.');
  }
}

function deadlineSignal(signal: AbortSignal, deadlineMs: number): AbortSignal {
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_CALL_DEADLINE_MS) {
    throw new Error('Realtime call deadline is outside the supported range.');
  }
  return AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
}

function abortError(): Error {
  return new Error('Realtime call request aborted.');
}

function awaitWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());

  let effect: Promise<T>;
  try {
    effect = operation();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });

    void effect.then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );

    if (signal.aborted) onAbort();
  });
}

function cancelResponseBody(response: Response): void {
  if (!response.body || response.body.locked) return;
  void response.body.cancel().catch(() => undefined);
}

function validatedHeader(value: string, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\r\n\0]/u.test(value)) {
    throw new Error(`Realtime ${label} is invalid.`);
  }
  return value;
}

function requestHeaders(credentials: RealtimeCredentials): Headers {
  const accessToken = validatedHeader(credentials.accessToken, 'access token');
  const accountId = validatedHeader(credentials.accountId, 'account ID');
  return new Headers({
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    'content-type': 'application/json',
    'openai-alpha': 'quicksilver=v2',
    originator: ORIGINATOR,
    'user-agent': USER_AGENT,
  });
}

async function loadCredentials(
  auth: RealtimeAuth,
  refresh: boolean,
  signal: AbortSignal,
): Promise<RealtimeCredentials> {
  try {
    return await awaitWithAbort(() => (refresh ? auth.refresh(signal) : auth.credentials(signal)), signal);
  } catch {
    throw new Error(signal.aborted ? 'Realtime call request aborted.' : 'Realtime authorization is unavailable.');
  }
}

function requestBody(sdp: string, instructions: string): string {
  return JSON.stringify({
    sdp,
    session: {
      instructions,
      audio: { output: { voice: REALTIME_VOICE } },
      delegation: { type: 'client' },
      model: REALTIME_MODEL,
    },
  });
}

async function readBoundedSdp(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > REALTIME_LIMITS.sdpBytes) {
      cancelResponseBody(response);
      throw new Error('Realtime call response exceeds the configured limit.');
    }
  }
  if (!response.body) throw new Error('Realtime call response has no SDP.');

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    cancelResponseBody(response);
    throw new Error('Realtime call response could not be read.');
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let complete = false;
  try {
    while (true) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await awaitWithAbort(() => reader.read(), signal);
      } catch {
        throw new Error(
          signal.aborted ? 'Realtime call request aborted.' : 'Realtime call response could not be read.',
        );
      }
      const { done, value } = result;
      if (done) {
        complete = true;
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > REALTIME_LIMITS.sdpBytes) {
        throw new Error('Realtime call response exceeds the configured limit.');
      }
      chunks.push(value);
    }
  } finally {
    const release = (): void => {
      try {
        reader.releaseLock();
      } catch {
        // A non-cooperative stream may retain its pending read after cancellation.
      }
    };
    if (complete) {
      release();
    } else {
      void reader
        .cancel()
        .catch(() => undefined)
        .then(release);
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let sdp: string;
  try {
    sdp = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Realtime call response is not valid UTF-8 SDP.');
  }
  if (!sdp) throw new Error('Realtime call response has no SDP.');
  return sdp;
}

function callIdFromLocation(location: string | null): string {
  if (!location) throw new Error('Realtime call response is missing its call ID.');
  const path = location.split('?', 1)[0] ?? '';
  const callId = path
    .split('/')
    .reverse()
    .find((segment) => /^rtc_.+$/u.test(segment) || /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(segment));
  if (!callId || callId.length > REALTIME_LIMITS.identifierCharacters) {
    throw new Error('Realtime call response has an invalid call ID.');
  }
  return callId;
}

function assertNoEndpointOverride(options: CodexRealtimeProviderOptions): void {
  if ('endpoint' in options) throw new Error('Realtime call endpoint cannot be overridden.');
}

export function createCodexRealtimeProvider(options: CodexRealtimeProviderOptions): RealtimeProvider {
  assertNoEndpointOverride(options);
  const deadlineMs = options.deadlineMs ?? DEFAULT_CALL_DEADLINE_MS;

  return {
    async createCall(request, signal) {
      assertBoundedRequest(request.sdp, request.instructions);
      const boundedSignal = deadlineSignal(signal, deadlineMs);
      const body = requestBody(request.sdp, request.instructions);
      let credentials = await loadCredentials(options.auth, false, boundedSignal);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        let response: Response;
        try {
          response = await awaitWithAbort(
            () =>
              options.fetch(ENDPOINT, {
                method: 'POST',
                headers: requestHeaders(credentials),
                body,
                redirect: 'error',
                signal: boundedSignal,
              }),
            boundedSignal,
            cancelResponseBody,
          );
        } catch {
          throw new Error(boundedSignal.aborted ? 'Realtime call request aborted.' : 'Realtime call request failed.');
        }

        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          cancelResponseBody(response);
          throw new Error('Realtime call redirect was rejected.');
        }
        if (response.status === 401 && attempt === 0) {
          cancelResponseBody(response);
          credentials = await loadCredentials(options.auth, true, boundedSignal);
          continue;
        }
        if (!response.ok) {
          cancelResponseBody(response);
          throw new Error(`Realtime call failed with HTTP ${response.status}.`);
        }

        const sdp = await readBoundedSdp(response, boundedSignal);
        const callId = callIdFromLocation(response.headers.get('location'));
        return { sdp, callId };
      }

      throw new Error('Realtime call authorization failed.');
    },
  };
}
