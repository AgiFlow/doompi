import { randomUUID } from 'node:crypto';
import type {
  DoomHubChannelSource,
  DoomHubSessionScope,
  DoomHubChannel,
} from '@agimon-ai/doompi-extension-contracts/hub-channel';
import {
  API_BASE_PATH,
  computerUseChannelType,
  COMPUTER_USE_ROUTES,
  type ComputerUseActivationRequest,
  type ComputerUseBrokerRequest,
  type ComputerUseBrowserCommand,
  type ComputerUseChannelPayload,
  type ComputerUseSessionView,
} from '../types/computerUseApi.ts';
import { computerUseSessionApiError, MissingComputerUseApiError } from './webComputerUseAvailability.ts';
export { computerUseChannelType };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function command(value: unknown): ComputerUseBrowserCommand | undefined {
  const input = record(value);
  return input?.action === 'status' ||
    input?.action === 'targets' ||
    input?.action === 'stop' ||
    input?.action === 'artifacts'
    ? { action: input.action }
    : undefined;
}

async function responseJson(response: Response): Promise<unknown> {
  const value = await response.json();
  if (!response.ok) throw computerUseSessionApiError(response.status, value);
  return value;
}

function sessionState(value: unknown): ComputerUseSessionView | undefined {
  const input = record(value);
  if (
    typeof input?.sessionId !== 'string' ||
    typeof input.revision !== 'number' ||
    typeof input.wake !== 'number' ||
    !['inactive', 'awaiting_confirmation', 'activating', 'active', 'stopping', 'failed'].includes(input.phase as string)
  )
    return undefined;
  return input as unknown as ComputerUseSessionView;
}

export function createComputerUseChannel(): DoomHubChannel {
  let receiveCommand: ((scope: DoomHubSessionScope, payload: unknown) => void) | undefined;
  return {
    frameType: computerUseChannelType,
    lifecycle: 'hub',
    start(host) {
      const scopes = new Map<string, DoomHubSessionScope>();
      const latest = new Map<string, ComputerUseChannelPayload>();
      const targets = new Map<string, readonly Record<string, unknown>[]>();
      const grants = new Map<string, string>();
      const subscriptions = new Map<string, () => void>();
      const processing = new Set<string>();
      let activeSessionId: string | undefined;
      let closed = false;

      const sessionRequest = async (scope: DoomHubSessionScope, path: string, method = 'GET', value?: unknown) =>
        host.requestSessionApi(scope, {
          basePath: API_BASE_PATH,
          path,
          method,
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        });

      const publish = (scope: DoomHubSessionScope, state: ComputerUseSessionView): void => {
        if (state.phase === 'active' || state.phase === 'activating' || state.phase === 'stopping') {
          activeSessionId = scope.sessionId;
        } else if (activeSessionId === scope.sessionId) {
          activeSessionId = undefined;
          grants.delete(scope.sessionId);
        }
        const payload: ComputerUseChannelPayload = {
          state,
          targets: targets.get(scope.sessionId) ?? [],
          ...(activeSessionId !== undefined && activeSessionId !== scope.sessionId ? { busy: true } : {}),
        };
        latest.set(scope.sessionId, payload);
        host.publish(scope.sessionId, payload);
      };

      const refresh = async (scope: DoomHubSessionScope): Promise<ComputerUseSessionView> => {
        const state = sessionState(await responseJson(await sessionRequest(scope, COMPUTER_USE_ROUTES.hubState)));
        if (state === undefined) throw new Error('Computer-use API returned an invalid session state.');
        publish(scope, state);
        return state;
      };

      const completePending = async (scope: DoomHubSessionScope, pending: ComputerUseBrokerRequest): Promise<void> => {
        if (!host.computerUse?.available) throw new Error('DoomPi Desktop computer use is unavailable.');
        try {
          const result = await host.computerUse.request(scope, {
            operation: pending.operation,
            payload:
              pending.operation === 'act'
                ? { grantId: pending.grantId, sequence: pending.sequence, action: pending.payload }
                : { grantId: pending.grantId },
          });
          await responseJson(
            await sessionRequest(scope, COMPUTER_USE_ROUTES.hubComplete, 'POST', { id: pending.id, result }),
          );
        } catch (error) {
          await responseJson(
            await sessionRequest(scope, COMPUTER_USE_ROUTES.hubComplete, 'POST', {
              id: pending.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      };

      const stopSession = async (scope: DoomHubSessionScope): Promise<void> => {
        const authorization = (await responseJson(
          await sessionRequest(scope, COMPUTER_USE_ROUTES.hubAuthorization),
        )) as { grantId: string } | null;
        let artifact: unknown;
        if (authorization !== null && host.computerUse?.available) {
          try {
            artifact = await host.computerUse.request(scope, {
              operation: 'stop',
              payload: { grantId: authorization.grantId },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            artifact = {
              artifactId: randomUUID(),
              status: 'failed',
              failure: { code: 'recording_failed', message: message.slice(0, 512) },
            };
            host.onNotice(`computer-use Desktop stop was already unavailable (${message})`);
          }
        }
        await responseJson(await sessionRequest(scope, COMPUTER_USE_ROUTES.hubStop, 'POST', { artifact }));
        grants.delete(scope.sessionId);
        if (activeSessionId === scope.sessionId) activeSessionId = undefined;
      };

      const processScope = async (scope: DoomHubSessionScope, announced?: ComputerUseSessionView): Promise<void> => {
        if (closed || processing.has(scope.sessionId)) return;
        processing.add(scope.sessionId);
        try {
          const state = announced ?? (await refresh(scope));
          if (state.phase === 'active') {
            if (!grants.has(scope.sessionId)) {
              const authorization = (await responseJson(
                await sessionRequest(scope, COMPUTER_USE_ROUTES.hubAuthorization),
              )) as { grantId: string } | null;
              if (authorization !== null) grants.set(scope.sessionId, authorization.grantId);
            }
            const expired = typeof state.expiresAt === 'number' && state.expiresAt <= Date.now();
            let owned = false;
            if (!expired && host.computerUse?.available) {
              try {
                const hostStatus = record(await host.computerUse.request(scope, { operation: 'status' }));
                owned = hostStatus?.ownedBySession === true;
              } catch {
                owned = true;
              }
            }
            if (expired || !owned) {
              await stopSession(scope);
              await refresh(scope);
              return;
            }
          }
          if (
            state.phase === 'awaiting_confirmation' &&
            (activeSessionId === undefined || activeSessionId === scope.sessionId)
          ) {
            if (!host.computerUse?.available) throw new Error('DoomPi Desktop computer use is unavailable.');
            const activation = (await responseJson(
              await sessionRequest(scope, COMPUTER_USE_ROUTES.hubActivation),
            )) as ComputerUseActivationRequest | null;
            if (activation !== null) {
              activeSessionId = scope.sessionId;
              try {
                const hostResult = await host.computerUse.request(scope, {
                  operation: 'activate',
                  payload: activation,
                });
                await responseJson(
                  await sessionRequest(scope, COMPUTER_USE_ROUTES.hubStop, 'POST', { host: hostResult }),
                );
                const grantId = record(hostResult)?.grantId;
                if (typeof grantId === 'string') grants.set(scope.sessionId, grantId);
              } catch (error) {
                activeSessionId = undefined;
                await responseJson(
                  await sessionRequest(scope, COMPUTER_USE_ROUTES.hubStop, 'POST', {
                    error: error instanceof Error ? error.message : String(error),
                  }),
                );
              }
              await refresh(scope);
            }
          }
          if (state.phase === 'stopping') {
            await stopSession(scope);
            await refresh(scope);
          }
          const pending = (await responseJson(
            await sessionRequest(scope, COMPUTER_USE_ROUTES.hubNext),
          )) as ComputerUseBrokerRequest | null;
          if (pending !== null) await completePending(scope, pending);
        } catch (error) {
          if (error instanceof MissingComputerUseApiError) {
            latest.delete(scope.sessionId);
          } else {
            host.onNotice(
              `computer-use state handling failed for ${scope.sessionId} (${error instanceof Error ? error.message : String(error)})`,
            );
          }
        } finally {
          processing.delete(scope.sessionId);
        }
      };

      const onState = (scope: DoomHubSessionScope, payload: unknown): void => {
        const state = sessionState(payload);
        if (state === undefined || state.sessionId !== scope.sessionId) return;
        publish(scope, state);
        void processScope(scope, state);
      };

      receiveCommand = (scope, payload) => {
        const parsed = command(payload);
        if (parsed === undefined) return;
        void (async () => {
          try {
            if (parsed.action === 'targets') {
              if (!host.computerUse?.available) throw new Error('DoomPi Desktop computer use is unavailable.');
              const result = await host.computerUse.request(scope, { operation: 'targets' });
              targets.set(
                scope.sessionId,
                Array.isArray(result)
                  ? result.filter((item): item is Record<string, unknown> => record(item) !== undefined)
                  : [],
              );
            } else if (parsed.action === 'stop') {
              await stopSession(scope);
            }
            await refresh(scope);
            void processScope(scope);
          } catch (error) {
            if (error instanceof MissingComputerUseApiError) {
              latest.delete(scope.sessionId);
            } else {
              host.onNotice(
                `computer-use command failed for ${scope.sessionId} (${error instanceof Error ? error.message : String(error)})`,
              );
            }
          }
        })();
      };

      const source: DoomHubChannelSource = {
        payloadFor: (scope) => latest.get(scope.sessionId),
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          const unsubscribe = host.directEvents.subscribe(
            computerUseChannelType,
            scope.sessionId,
            (payload) => onState(scope, payload),
            { replayLatest: true },
          );
          subscriptions.set(scope.sessionId, unsubscribe);
          void processScope(scope);
        },
        sessionRemoved(sessionId) {
          const scope = scopes.get(sessionId);
          const grantId = grants.get(sessionId);
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          if (scope !== undefined && grantId !== undefined && host.computerUse?.available) {
            void host.computerUse
              .request(scope, { operation: 'stop', payload: { grantId } })
              .catch((error: unknown) =>
                host.onNotice(
                  `computer-use session cleanup failed (${error instanceof Error ? error.message : String(error)})`,
                ),
              );
          }
          scopes.delete(sessionId);
          latest.delete(sessionId);
          targets.delete(sessionId);
          grants.delete(sessionId);
          processing.delete(sessionId);
          if (activeSessionId === sessionId) activeSessionId = undefined;
        },
        close() {
          closed = true;
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          if (host.computerUse?.available) {
            for (const [sessionId, grantId] of grants) {
              const scope = scopes.get(sessionId);
              if (scope !== undefined)
                void host.computerUse
                  .request(scope, { operation: 'stop', payload: { grantId } })
                  .catch(() => undefined);
            }
          }
          scopes.clear();
          latest.clear();
          targets.clear();
          grants.clear();
        },
      };
      return source;
    },
    receive(scope, payload) {
      receiveCommand?.(scope, payload);
    },
  };
}
