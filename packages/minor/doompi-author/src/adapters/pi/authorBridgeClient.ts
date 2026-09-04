import http from 'node:http';
import {
  DOOM_API_INTERNAL_TOKEN_ENV,
  DOOM_API_ROUTE_PREFIX,
  DOOM_API_SOCKET_ENV,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import type { AuthorCatalog } from '../../services/authorCatalog.ts';
import { API_BASE_PATH, AUTHOR_BRIDGE_ROUTES } from '../../types/authorApi.ts';
import type { AuthorToolResult, AuthorViewportCatalogSnapshot, UseAuthorToolInput } from '../../types/author.ts';

interface ClientOptions {
  socketPath: string;
  token: string;
}

export class UnixAuthorCatalog implements AuthorCatalog {
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

  public async describe(signal?: AbortSignal): Promise<AuthorViewportCatalogSnapshot> {
    return (await this.request(
      AUTHOR_BRIDGE_ROUTES.describe,
      'GET',
      undefined,
      signal,
    )) as AuthorViewportCatalogSnapshot;
  }

  public async execute(input: UseAuthorToolInput, signal?: AbortSignal): Promise<AuthorToolResult> {
    return (await this.request(AUTHOR_BRIDGE_ROUTES.invoke, 'POST', input, signal)) as AuthorToolResult;
  }
}

class UnavailableAuthorCatalog implements AuthorCatalog {
  public describe(): Promise<AuthorViewportCatalogSnapshot> {
    return Promise.reject(new Error('The Author session API is unavailable.'));
  }

  public execute(): Promise<AuthorToolResult> {
    return Promise.reject(new Error('The Author session API is unavailable.'));
  }
}

export function createAuthorCatalog(environment: NodeJS.ProcessEnv = process.env): AuthorCatalog {
  const socketPath = environment[DOOM_API_SOCKET_ENV];
  const token = environment[DOOM_API_INTERNAL_TOKEN_ENV];
  return socketPath && token ? new UnixAuthorCatalog({ socketPath, token }) : new UnavailableAuthorCatalog();
}
