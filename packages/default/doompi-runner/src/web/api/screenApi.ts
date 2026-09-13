import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

import { RUNNER_SCREEN_EVENT } from '../../constants/webRunnerLog';
import { type RunnerScreenEvent, runnerInputUrl, runnerScreenStreamUrl } from '../../types/webRunnerLog';

/**
 * The page's half of the attached pane.
 *
 * Two directions over two mechanisms, because the hub proxies requests and
 * server-sent events but cannot upgrade a socket: pane bytes arrive on an
 * EventSource, and keystrokes go back as ordinary POSTs.
 */

/** Turns one base64 chunk back into the bytes a terminal was sent. */
export function decodeChunk(chunk: string): Uint8Array {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface RunnerScreenWatch {
  close(): void;
}

/** Attempts before a dropped screen stream is reported as lost rather than retried. */
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function watchRunnerScreen(
  sessionId: string,
  runId: string,
  from: number,
  handlers: { onEvent(event: RunnerScreenEvent): void; onLost(): void },
): RunnerScreenWatch {
  let offset = from;
  let retries = 0;
  let closed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = (): void => {
    if (closed) return;
    const current = new EventSource(runnerScreenStreamUrl(sessionId, runId, offset));
    source = current;
    current.addEventListener(RUNNER_SCREEN_EVENT, (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse((message as MessageEvent<string>).data);
      } catch {
        return;
      }
      if (!isRecord(parsed) || typeof parsed.chunk !== 'string') return;
      const event = parsed as unknown as RunnerScreenEvent;
      // Every delivered byte moves the resume point, so a reconnect asks for
      // what comes next rather than repainting everything again.
      if (typeof event.offset === 'number') offset = event.offset;
      retries = 0;
      // The server closes after this one, and a close reaches us as an error.
      if (event.ended === true) {
        closed = true;
        current.close();
      }
      handlers.onEvent(event);
    });
    current.addEventListener('error', () => {
      current.close();
      if (closed) return;
      retries += 1;
      if (retries > MAX_RETRIES) {
        handlers.onLost();
        return;
      }
      timer = setTimeout(open, RETRY_BASE_MS * 2 ** (retries - 1));
    });
  };

  open();
  return {
    close: () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      source?.close();
    },
  };
}

/** Sends one batch of keystrokes. Resolves to whether the pane took them. */
export async function sendRunnerInput(sessionId: string, runId: string, text: string): Promise<boolean> {
  try {
    const response = await sealedTransport.fetch(runnerInputUrl(sessionId, runId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
