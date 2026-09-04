import http from 'node:http';
import {
  DOOM_API_INTERNAL_TOKEN_ENV,
  DOOM_API_ROUTE_PREFIX,
  DOOM_API_SOCKET_ENV,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import { API_BASE_PATH, COMPUTER_USE_ROUTES, type ComputerUseSessionView } from '../../types/computerUseApi.ts';
import type { ComputerUseAction, ComputerUseObservation } from '../../types/computerUse.ts';

export interface ComputerUseSessionClient {
  state(signal?: AbortSignal): Promise<ComputerUseSessionView>;
  observe(signal?: AbortSignal): Promise<ComputerUseObservation>;
  act(action: ComputerUseAction, signal?: AbortSignal): Promise<unknown>;
  stop(signal?: AbortSignal): Promise<ComputerUseSessionView>;
}

interface ClientOptions {
  readonly socketPath: string;
  readonly token: string;
}

export class UnixComputerUseSessionClient implements ComputerUseSessionClient {
  public constructor(private readonly options: ClientOptions) {}

  private request(path: string, method: 'GET' | 'POST', value?: unknown, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = value === undefined ? undefined : JSON.stringify(value);
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          path: `${DOOM_API_ROUTE_PREFIX}/${API_BASE_PATH}${path}`,
          method,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          },
          signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
              if ((response.statusCode ?? 500) >= 400) {
                const message =
                  typeof parsed === 'object' && parsed !== null && 'error' in parsed
                    ? String(parsed.error)
                    : `HTTP ${response.statusCode}`;
                reject(new Error(message));
              } else resolve(parsed);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  public async state(signal?: AbortSignal): Promise<ComputerUseSessionView> {
    return (await this.request(COMPUTER_USE_ROUTES.agentState, 'GET', undefined, signal)) as ComputerUseSessionView;
  }

  public async observe(signal?: AbortSignal): Promise<ComputerUseObservation> {
    return (await this.request(COMPUTER_USE_ROUTES.agentObserve, 'POST', {}, signal)) as ComputerUseObservation;
  }

  public act(action: ComputerUseAction, signal?: AbortSignal): Promise<unknown> {
    return this.request(COMPUTER_USE_ROUTES.agentAction, 'POST', action, signal);
  }

  public async stop(signal?: AbortSignal): Promise<ComputerUseSessionView> {
    return (await this.request(COMPUTER_USE_ROUTES.agentStop, 'POST', {}, signal)) as ComputerUseSessionView;
  }
}

export function createComputerUseSessionClient(
  environment: NodeJS.ProcessEnv = process.env,
): ComputerUseSessionClient | undefined {
  const socketPath = environment[DOOM_API_SOCKET_ENV];
  const token = environment[DOOM_API_INTERNAL_TOKEN_ENV];
  return socketPath && token ? new UnixComputerUseSessionClient({ socketPath, token }) : undefined;
}
