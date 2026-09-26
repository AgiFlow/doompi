import type {
  DoomHubChannelConnection,
  DoomHubChannelHost,
  DoomHubChannelSource,
  DoomHubSessionScope,
  DoomHubChannel,
} from '@agimon-ai/doompi-core/hubChannel';

import { AUTHOR_ALIAS_PATTERN } from '../../schemas/authorTools';
import routes from '../../types/apiRoutes';
import { API_BASE_PATH } from '../../types/authorApi';
import { authorChannelType, type AuthorBrowserMessage, type AuthorHubMessage } from '../../types/webAuthor';

/**
 * Which route carries each message the browser sends.
 *
 * The paths come from the package's one route table, so the hub cannot address
 * a bridge route the session no longer serves. `release` is absent because it
 * is answered by the disconnect route rather than one of its own.
 */
const BRIDGE_ROUTE: Readonly<Record<Exclude<AuthorBrowserMessage['kind'], 'release'>, string>> = {
  register: routes.bridgeRegister.path,
  catalog: routes.bridgeCatalog.path,
  result: routes.bridgeResult.path,
  cancelled: routes.bridgeCancelled.path,
};

interface Binding {
  alias: string;
  scope: DoomHubSessionScope;
  connectionId: string;
  generation: number;
  ownerToken: string;
  poll?: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function browserMessage(value: unknown): AuthorBrowserMessage | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    typeof value.alias !== 'string' ||
    !AUTHOR_ALIAS_PATTERN.test(value.alias)
  )
    return undefined;
  if (!['register', 'release', 'catalog', 'result', 'cancelled'].includes(value.kind)) return undefined;
  return value as unknown as AuthorBrowserMessage;
}

async function responsePayload(response: Response): Promise<AuthorHubMessage> {
  const value = (await response.json()) as unknown;
  if (response.ok) return value as AuthorHubMessage;
  const reason =
    isRecord(value) && typeof value.error === 'string' ? value.error : `Author bridge HTTP ${response.status}`;
  return { kind: 'rejected', reason };
}

export function createAuthorChannel(): DoomHubChannel {
  const bindings = new Map<string, Binding>();
  let host: DoomHubChannelHost | undefined;
  let closed = false;
  const keyOf = (sessionId: string, connectionId: string, alias: string): string =>
    `${sessionId}\0${connectionId}\0${alias}`;
  const send = async (scope: DoomHubSessionScope, path: string, value: Record<string, unknown>, signal?: AbortSignal) =>
    await host!.requestSessionApi(scope, {
      basePath: API_BASE_PATH,
      path,
      method: 'POST',
      body: JSON.stringify(value),
      ...(signal === undefined ? {} : { signal }),
    });
  const publish = (binding: Binding, payload: AuthorHubMessage): boolean =>
    host?.publishToConnection?.(binding.connectionId, binding.scope.sessionId, { ...payload, alias: binding.alias }) ??
    false;

  const poll = async (binding: Binding): Promise<void> => {
    binding.poll?.abort();
    const controller = new AbortController();
    binding.poll = controller;
    while (!closed && bindings.get(keyOf(binding.scope.sessionId, binding.connectionId, binding.alias)) === binding) {
      try {
        const response = await send(
          binding.scope,
          routes.bridgeNext.path,
          {
            alias: binding.alias,
            bindingId: binding.connectionId,
            generation: binding.generation,
            ownerToken: binding.ownerToken,
          },
          controller.signal,
        );
        const payload = await responsePayload(response);
        if (!publish(binding, payload) || payload.kind === 'rejected') break;
      } catch (error) {
        if (!controller.signal.aborted) host?.onNotice(error instanceof Error ? error.message : String(error));
        break;
      }
    }
  };

  const channel: DoomHubChannel = {
    frameType: authorChannelType,
    lifecycle: 'hub',
    receiveWithoutSubscription: true,
    start(channelHost) {
      host = channelHost;
      const source: DoomHubChannelSource = {
        payloadFor: () => undefined,
        sessionRemoved(sessionId) {
          for (const [key, binding] of bindings) {
            if (binding.scope.sessionId !== sessionId) continue;
            binding.poll?.abort();
            bindings.delete(key);
            void send(binding.scope, routes.bridgeDisconnect.path, {
              alias: binding.alias,
              bindingId: binding.connectionId,
              generation: binding.generation,
            }).catch((error: unknown) => host?.onNotice(error instanceof Error ? error.message : String(error)));
          }
        },
        close() {
          closed = true;
          for (const binding of bindings.values()) {
            binding.poll?.abort();
            void send(binding.scope, routes.bridgeDisconnect.path, {
              alias: binding.alias,
              bindingId: binding.connectionId,
              generation: binding.generation,
            }).catch((error: unknown) => host?.onNotice(error instanceof Error ? error.message : String(error)));
          }
          bindings.clear();
        },
      };
      return source;
    },
    receive(scope, payload, connection) {
      const message = browserMessage(payload);
      if (message === undefined || host === undefined || closed) return;
      void (async () => {
        const key = keyOf(scope.sessionId, connection.connectionId, message.alias);
        const previous = bindings.get(key);
        if (message.kind === 'release') {
          if (previous === undefined || previous.generation !== message.generation) return;
          previous.poll?.abort();
          bindings.delete(key);
          await send(scope, routes.bridgeDisconnect.path, {
            alias: message.alias,
            bindingId: connection.connectionId,
            generation: message.generation,
          });
          return;
        }
        const route = BRIDGE_ROUTE[message.kind];
        const response = await send(scope, route, { ...message, bindingId: connection.connectionId });
        const reply = await responsePayload(response);
        if (reply.kind === 'accepted') {
          const binding: Binding = {
            alias: message.alias,
            scope,
            connectionId: connection.connectionId,
            generation: reply.generation,
            ownerToken: reply.ownerToken,
          };
          previous?.poll?.abort();
          bindings.set(key, binding);
          publish(binding, reply);
          void poll(binding);
        } else if (reply.kind === 'rejected') {
          if (previous !== undefined) publish(previous, reply);
          else
            host?.publishToConnection?.(connection.connectionId, scope.sessionId, { ...reply, alias: message.alias });
        }
      })().catch((error: unknown) => host?.onNotice(error instanceof Error ? error.message : String(error)));
    },
    disconnected(connection: DoomHubChannelConnection) {
      for (const [key, binding] of bindings) {
        if (binding.connectionId !== connection.connectionId) continue;
        binding.poll?.abort();
        bindings.delete(key);
        void send(binding.scope, routes.bridgeDisconnect.path, {
          alias: binding.alias,
          bindingId: binding.connectionId,
          generation: binding.generation,
        }).catch((error: unknown) => host?.onNotice(error instanceof Error ? error.message : String(error)));
      }
    },
  };
  return channel;
}
