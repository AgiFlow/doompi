import type {
  HubChannelConnection,
  HubChannelHost,
  HubChannelSource,
  HubSessionScope,
  WebHubChannel,
} from '@agimon-ai/doompi-web-contracts';
import { API_BASE_PATH, AUTHOR_BRIDGE_ROUTES } from '../types/authorApi.ts';
import { authorChannelType, type AuthorBrowserMessage, type AuthorHubMessage } from '../types/webAuthor.ts';

interface Binding {
  scope: HubSessionScope;
  connectionId: string;
  generation: number;
  ownerToken: string;
  poll?: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function browserMessage(value: unknown): AuthorBrowserMessage | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
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

export function createAuthorChannel(): WebHubChannel {
  const bindings = new Map<string, Binding>();
  let host: HubChannelHost | undefined;
  let closed = false;
  const keyOf = (sessionId: string, connectionId: string): string => `${sessionId}\0${connectionId}`;
  const send = async (scope: HubSessionScope, path: string, value: Record<string, unknown>, signal?: AbortSignal) =>
    await host!.requestSessionApi(scope, {
      basePath: API_BASE_PATH,
      path,
      method: 'POST',
      body: JSON.stringify(value),
      ...(signal === undefined ? {} : { signal }),
    });
  const publish = (binding: Binding, payload: AuthorHubMessage): boolean =>
    host?.publishToConnection?.(binding.connectionId, binding.scope.sessionId, payload) ?? false;

  const poll = async (binding: Binding): Promise<void> => {
    binding.poll?.abort();
    const controller = new AbortController();
    binding.poll = controller;
    while (!closed && bindings.get(keyOf(binding.scope.sessionId, binding.connectionId)) === binding) {
      try {
        const response = await send(
          binding.scope,
          AUTHOR_BRIDGE_ROUTES.next,
          {
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

  const channel: WebHubChannel = {
    frameType: authorChannelType,
    lifecycle: 'hub',
    receiveWithoutSubscription: true,
    start(channelHost) {
      host = channelHost;
      const source: HubChannelSource = {
        payloadFor: () => undefined,
        sessionRemoved(sessionId) {
          for (const [key, binding] of bindings) {
            if (binding.scope.sessionId !== sessionId) continue;
            binding.poll?.abort();
            bindings.delete(key);
            void send(binding.scope, AUTHOR_BRIDGE_ROUTES.disconnect, {
              bindingId: binding.connectionId,
              generation: binding.generation,
            }).catch((error: unknown) => host?.onNotice(error instanceof Error ? error.message : String(error)));
          }
        },
        close() {
          closed = true;
          for (const binding of bindings.values()) {
            binding.poll?.abort();
            void send(binding.scope, AUTHOR_BRIDGE_ROUTES.disconnect, {
              bindingId: binding.connectionId,
              generation: binding.generation,
            }).catch(() => undefined);
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
        const key = keyOf(scope.sessionId, connection.connectionId);
        const previous = bindings.get(key);
        if (message.kind === 'release') {
          if (previous === undefined || previous.generation !== message.generation) return;
          previous.poll?.abort();
          bindings.delete(key);
          await send(scope, AUTHOR_BRIDGE_ROUTES.disconnect, {
            bindingId: connection.connectionId,
            generation: message.generation,
          });
          return;
        }
        const route = AUTHOR_BRIDGE_ROUTES[message.kind];
        const response = await send(scope, route, { ...message, bindingId: connection.connectionId });
        const reply = await responsePayload(response);
        if (reply.kind === 'accepted') {
          const binding: Binding = {
            scope,
            connectionId: connection.connectionId,
            generation: reply.generation,
            ownerToken: reply.ownerToken,
          };
          previous?.poll?.abort();
          bindings.set(key, binding);
          publish(binding, reply);
          void poll(binding);
        } else if (reply.kind === 'rejected' && previous !== undefined) publish(previous, reply);
      })().catch((error: unknown) => host?.onNotice(error instanceof Error ? error.message : String(error)));
    },
    disconnected(connection: HubChannelConnection) {
      for (const [key, binding] of bindings) {
        if (binding.connectionId !== connection.connectionId) continue;
        binding.poll?.abort();
        bindings.delete(key);
        void send(binding.scope, AUTHOR_BRIDGE_ROUTES.disconnect, {
          bindingId: binding.connectionId,
          generation: binding.generation,
        }).catch((error: unknown) => host?.onNotice(error instanceof Error ? error.message : String(error)));
      }
    },
  };
  return channel;
}

export const webHubChannels: readonly WebHubChannel[] = [createAuthorChannel()];
