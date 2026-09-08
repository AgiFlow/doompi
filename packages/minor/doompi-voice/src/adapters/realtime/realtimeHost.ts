import http from 'node:http';
import {
  DOOM_API_INTERNAL_TOKEN_ENV,
  DOOM_API_ROUTE_PREFIX,
  DOOM_API_SOCKET_ENV,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import { VOICE_MEDIA_API_BASE_PATH } from '../../types/clientMedia.ts';
import { REALTIME_ROUTES, type RealtimeControl, type RealtimeHostSnapshot } from '../../types/realtime.ts';

export interface RealtimeHost {
  start(activationId: string, instructions: string, signal: AbortSignal): Promise<void>;
  poll(activationId: string, after: number, signal: AbortSignal): Promise<RealtimeHostSnapshot>;
  send(activationId: string, messages: string[], signal: AbortSignal): Promise<void>;
  control(activationId: string, action: RealtimeControl, signal: AbortSignal): Promise<void>;
  stop(activationId: string): Promise<void>;
}

/** Host-only authenticated IPC. Neither subscription credentials nor raw audio cross this boundary. */
export class UnixRealtimeHost implements RealtimeHost {
  public constructor(private readonly options: { socketPath: string; internalToken: string }) {}
  public async start(activationId: string, instructions: string, signal: AbortSignal): Promise<void> {
    await this.request(REALTIME_ROUTES.hostStart, { activationId, instructions }, signal);
  }
  public async poll(activationId: string, after: number, signal: AbortSignal): Promise<RealtimeHostSnapshot> {
    const result = await this.request(
      `${REALTIME_ROUTES.hostPoll}?activationId=${encodeURIComponent(activationId)}&after=${after}`,
      undefined,
      signal,
    );
    if (typeof result !== 'object' || result === null) throw new Error('Invalid live voice host state.');
    const snapshot = result as RealtimeHostSnapshot;
    if (
      snapshot.activationId !== activationId ||
      !Number.isSafeInteger(snapshot.cursor) ||
      snapshot.cursor < after ||
      !['connecting', 'active', 'closed', 'failed'].includes(snapshot.state) ||
      !Array.isArray(snapshot.events) ||
      snapshot.events.length > 64
    )
      throw new Error('Invalid live voice host state.');
    return snapshot;
  }
  public async send(activationId: string, messages: string[], signal: AbortSignal): Promise<void> {
    await this.request(REALTIME_ROUTES.hostSend, { activationId, messages }, signal);
  }
  public async control(activationId: string, action: RealtimeControl, signal: AbortSignal): Promise<void> {
    await this.request(REALTIME_ROUTES.hostControl, { activationId, action }, signal);
  }
  public async stop(activationId: string): Promise<void> {
    await this.request(REALTIME_ROUTES.hostStop, { activationId }, new AbortController().signal);
  }

  private request(route: string, payload: object | undefined, parent: AbortSignal): Promise<unknown> {
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const signal = AbortSignal.any([parent, AbortSignal.timeout(5_000)]);
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          path: `${DOOM_API_ROUTE_PREFIX}/${VOICE_MEDIA_API_BASE_PATH}${route}`,
          method: body ? 'POST' : 'GET',
          signal,
          headers: {
            authorization: `Bearer ${this.options.internalToken}`,
            ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1_048_576) {
              request.destroy(new Error('Live voice host response is too large.'));
              return;
            }
            chunks.push(chunk);
          });
          response.once('error', () => reject(new Error('Live voice host response failed.')));
          response.once('end', () => {
            if ((response.statusCode ?? 500) >= 300) {
              reject(
                new Error('Live voice host rejected the operation. Check browser ownership and subscription sign-in.'),
              );
              return;
            }
            try {
              resolve(size === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              reject(new Error('Live voice host returned invalid JSON.'));
            }
          });
        },
      );
      request.once('error', () =>
        reject(
          new Error(
            signal.aborted ? 'Live voice host request cancelled or timed out.' : 'Live voice host connection failed.',
          ),
        ),
      );
      request.end(body);
    });
  }
}

export function realtimeHostConnection(environment: NodeJS.ProcessEnv = process.env): RealtimeHost | undefined {
  const socketPath = environment[DOOM_API_SOCKET_ENV];
  const internalToken = environment[DOOM_API_INTERNAL_TOKEN_ENV];
  return socketPath && internalToken ? new UnixRealtimeHost({ socketPath, internalToken }) : undefined;
}
