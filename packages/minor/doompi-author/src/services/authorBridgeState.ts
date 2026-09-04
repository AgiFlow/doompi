import type {
  AuthorToolResult,
  AuthorViewportCapabilityDescriptor,
  AuthorViewportCatalogSnapshot,
  UseAuthorToolInput,
} from '../types/author.ts';
import type { AuthorAcceptedMessage, AuthorCancelMessage, AuthorRequestMessage } from '../types/webAuthor.ts';

export const AUTHOR_REQUEST_TIMEOUT_MS = 15_000;
export const AUTHOR_OWNER_LEASE_MS = 10_000;

export class AuthorBridgeError extends Error {
  public constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 503 = 409,
  ) {
    super(message);
  }
}

interface Owner {
  bindingId: string;
  generation: number;
  ownerToken: string;
  expiresAt: number;
  catalogToken?: string;
  tools: AuthorViewportCapabilityDescriptor[];
}

interface Pending {
  request: AuthorRequestMessage;
  resolve(value: AuthorToolResult): void;
  reject(error: Error): void;
  cancelTimer(): void;
  removeAbort?: () => void;
}

type Delivery = AuthorRequestMessage | AuthorCancelMessage;

export interface AuthorBridgeStateOptions {
  now: () => number;
  issueToken: () => string;
  scheduleTimeout: (callback: () => void, delayMs: number) => () => void;
  requestTimeoutMs?: number;
  leaseMs?: number;
}

export interface AuthorBridgeState {
  register(bindingId: string, generation: number): AuthorAcceptedMessage;
  catalog(
    bindingId: string,
    generation: number,
    ownerToken: string,
    tools: AuthorViewportCapabilityDescriptor[],
  ): AuthorAcceptedMessage;
  describe(): AuthorViewportCatalogSnapshot;
  invoke(input: UseAuthorToolInput, signal?: AbortSignal): Promise<AuthorToolResult>;
  next(bindingId: string, generation: number, ownerToken: string, signal?: AbortSignal): Promise<Delivery>;
  result(
    bindingId: string,
    generation: number,
    ownerToken: string,
    catalogToken: string,
    requestId: string,
    result: unknown,
  ): void;
  cancelled(bindingId: string, generation: number, ownerToken: string, catalogToken: string, requestId: string): void;
  disconnect(bindingId: string): void;
  close(): void;
}

export function createAuthorBridgeState(options: AuthorBridgeStateOptions): AuthorBridgeState {
  const { now, issueToken, scheduleTimeout } = options;
  const timeoutMs = options.requestTimeoutMs ?? AUTHOR_REQUEST_TIMEOUT_MS;
  const leaseMs = options.leaseMs ?? AUTHOR_OWNER_LEASE_MS;
  let owner: Owner | undefined;
  let pending: Pending | undefined;
  let delivery: Delivery | undefined;
  let deliveryWaiter: { resolve(value: Delivery): void; reject(error: Error): void } | undefined;
  const tombstones = new Set<string>();

  const rememberCancellation = (requestId: string): void => {
    tombstones.add(requestId);
    if (tombstones.size > 100) tombstones.delete(tombstones.values().next().value!);
  };
  const publishDelivery = (value: Delivery): void => {
    if (deliveryWaiter === undefined) delivery = value;
    else {
      const waiter = deliveryWaiter;
      deliveryWaiter = undefined;
      waiter.resolve(value);
    }
  };
  const rejectPending = (reason: string, sendCancel: boolean): void => {
    const current = pending;
    if (current === undefined) return;
    pending = undefined;
    current.cancelTimer();
    current.removeAbort?.();
    rememberCancellation(current.request.requestId);
    if (sendCancel) publishDelivery({ ...current.request, kind: 'cancel' });
    current.reject(new AuthorBridgeError(reason, 503));
  };
  const liveOwner = (): Owner => {
    if (owner === undefined) throw new AuthorBridgeError('No Author viewport is registered.', 503);
    if (owner.expiresAt <= now()) {
      rejectPending('The Author viewport lease expired.', false);
      owner = undefined;
      throw new AuthorBridgeError('The Author viewport lease expired.', 503);
    }
    return owner;
  };
  const assertOwner = (bindingId: string, generation: number, ownerToken: string): Owner => {
    const current = liveOwner();
    if (current.bindingId !== bindingId || current.generation !== generation || current.ownerToken !== ownerToken) {
      throw new AuthorBridgeError('Stale Author viewport binding.');
    }
    return current;
  };
  const assertRequest = (
    bindingId: string,
    generation: number,
    ownerToken: string,
    catalogToken: string,
    requestId: string,
  ): Pending => {
    const currentOwner = assertOwner(bindingId, generation, ownerToken);
    if (currentOwner.catalogToken !== catalogToken) throw new AuthorBridgeError('Stale Author catalog token.');
    if (tombstones.has(requestId)) throw new AuthorBridgeError('The Author request was already cancelled.');
    if (pending?.request.requestId !== requestId) throw new AuthorBridgeError('Stale Author request.');
    return pending;
  };

  return {
    register(bindingId, generation) {
      if (bindingId === '' || !Number.isSafeInteger(generation) || generation < 0) {
        throw new AuthorBridgeError('Invalid Author registration.', 400);
      }
      if (owner !== undefined && owner.expiresAt > now()) {
        if (owner.bindingId !== bindingId) throw new AuthorBridgeError('Another Author viewport owns the lease.');
        if (generation < owner.generation) throw new AuthorBridgeError('Stale Author generation.');
        if (generation === owner.generation) {
          owner.expiresAt = now() + leaseMs;
          return {
            kind: 'accepted',
            generation,
            ownerToken: owner.ownerToken,
            ...(owner.catalogToken === undefined ? {} : { catalogToken: owner.catalogToken }),
            leaseMs,
          };
        }
      }
      rejectPending('The Author viewport generation changed.', false);
      delivery = undefined;
      const current: Owner = {
        bindingId,
        generation,
        ownerToken: issueToken(),
        expiresAt: now() + leaseMs,
        tools: [],
      };
      owner = current;
      return { kind: 'accepted', generation, ownerToken: current.ownerToken, leaseMs };
    },
    catalog(bindingId, generation, ownerToken, tools) {
      const current = assertOwner(bindingId, generation, ownerToken);
      if (!Array.isArray(tools) || tools.length > 15) throw new AuthorBridgeError('Invalid Author catalog.', 400);
      const names = new Set<string>();
      for (const tool of tools) {
        if (
          typeof tool !== 'object' ||
          tool === null ||
          typeof tool.name !== 'string' ||
          !/^[a-z][a-z0-9_]{0,29}$/.test(tool.name) ||
          typeof tool.label !== 'string' ||
          typeof tool.description !== 'string' ||
          typeof tool.inputSchema !== 'object' ||
          tool.inputSchema === null ||
          Array.isArray(tool.inputSchema) ||
          names.has(tool.name)
        ) {
          throw new AuthorBridgeError('Invalid Author catalog.', 400);
        }
        names.add(tool.name);
      }
      if (pending !== undefined) throw new AuthorBridgeError('Cannot replace the Author catalog during a request.');
      current.tools = tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
      current.catalogToken = issueToken();
      current.expiresAt = now() + leaseMs;
      return {
        kind: 'accepted',
        generation,
        ownerToken,
        catalogToken: current.catalogToken,
        leaseMs,
      };
    },
    describe() {
      const current = liveOwner();
      if (current.catalogToken === undefined) throw new AuthorBridgeError('The Author viewport has no catalog.', 503);
      return { catalogToken: current.catalogToken, tools: current.tools };
    },
    invoke(input, signal) {
      let current: Owner;
      try {
        current = liveOwner();
        if (current.catalogToken !== input.catalogToken)
          throw new AuthorBridgeError('The Author capability catalog changed.');
        if (!current.tools.some((tool) => tool.name === input.name)) {
          throw new AuthorBridgeError(`Unknown Author capability: ${input.name}`, 404);
        }
        if (pending !== undefined) throw new AuthorBridgeError('Another Author request is already pending.');
        if (signal?.aborted)
          throw signal.reason instanceof Error ? signal.reason : new Error('Author request cancelled.');
      } catch (error) {
        return Promise.reject(error);
      }
      const request: AuthorRequestMessage = {
        kind: 'request',
        generation: current.generation,
        ownerToken: current.ownerToken,
        catalogToken: current.catalogToken!,
        requestId: issueToken(),
        name: input.name,
        arguments: input.arguments,
      };
      return new Promise<AuthorToolResult>((resolve, reject) => {
        const cancel = (reason: string): void => rejectPending(reason, true);
        const cancelTimer = scheduleTimeout(
          () => cancel('The Author request timed out.'),
          Math.min(timeoutMs, current.expiresAt - now()),
        );
        pending = { request, resolve, reject, cancelTimer };
        if (signal !== undefined) {
          const onAbort = () => cancel('The Author request was cancelled.');
          signal.addEventListener('abort', onAbort, { once: true });
          pending.removeAbort = () => signal.removeEventListener('abort', onAbort);
        }
        publishDelivery(request);
      });
    },
    async next(bindingId, generation, ownerToken, signal) {
      assertOwner(bindingId, generation, ownerToken);
      if (delivery !== undefined) {
        const value = delivery;
        delivery = undefined;
        return value;
      }
      if (deliveryWaiter !== undefined) throw new AuthorBridgeError('An Author delivery poll is already active.');
      return await new Promise<Delivery>((resolve, reject) => {
        let waiter: { resolve(value: Delivery): void; reject(error: Error): void };
        const onAbort = (): void => {
          if (deliveryWaiter === waiter) deliveryWaiter = undefined;
          reject(signal?.reason ?? new Error('Author delivery poll cancelled.'));
        };
        waiter = {
          resolve(value) {
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
          },
          reject,
        };
        deliveryWaiter = waiter;
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    result(bindingId, generation, ownerToken, catalogToken, requestId, result) {
      const current = assertRequest(bindingId, generation, ownerToken, catalogToken, requestId);
      pending = undefined;
      current.cancelTimer();
      current.removeAbort?.();
      current.resolve({ catalogToken, name: current.request.name, result });
    },
    cancelled(bindingId, generation, ownerToken, catalogToken, requestId) {
      const current = assertRequest(bindingId, generation, ownerToken, catalogToken, requestId);
      pending = undefined;
      current.cancelTimer();
      current.removeAbort?.();
      rememberCancellation(requestId);
      current.reject(new AuthorBridgeError('The Author viewport cancelled the request.'));
    },
    disconnect(bindingId) {
      if (owner?.bindingId !== bindingId) return;
      rejectPending('The Author viewport disconnected.', false);
      owner = undefined;
      delivery = undefined;
    },
    close() {
      rejectPending('The Author bridge closed.', false);
      owner = undefined;
      delivery = undefined;
      deliveryWaiter?.reject(new Error('The Author bridge closed.'));
      deliveryWaiter = undefined;
    },
  };
}
