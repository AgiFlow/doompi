import type { DoomExtensionContext } from '@agimon-ai/doompi-extension-contracts/config';
import {
  MINOR_MODE_ACTION_TIMEOUT_MS,
  MINOR_MODE_CATALOG_SOURCE,
  MINOR_MODE_ERROR_CODE,
  MINOR_MODE_MAX_RECORDS,
  type MinorModeActionRequest,
  type MinorModeActionResponse,
  type MinorModeCatalogService,
  type MinorModeCatalogSnapshot,
  type MinorModeOwnerDefinition,
  type MinorModeOwnerHandle,
  type MinorModeRecord,
  type MinorModeRegistrationRef,
  type MinorModeSessionKind,
  minorModeKey,
  validateMinorModeActionArguments,
  validateMinorModeDefinition,
} from '@agimon-ai/doompi-extension-contracts/mode';
import { DoomProtocolError } from '@agimon-ai/doompi-extension-contracts/protocol';

export interface MinorModeCatalogHostOptions<ExtensionContext extends DoomExtensionContext = DoomExtensionContext> {
  sessionKind: MinorModeSessionKind;
  context: ExtensionContext;
  actionTimeoutMs?: number;
  restoreSnapshot?: MinorModeCatalogSnapshot;
  onRestorationError?(error: unknown): void;
  routeInvocation?(
    request: MinorModeActionRequest,
    requesterSource: string,
    invoke: () => Promise<MinorModeActionResponse>,
  ): Promise<MinorModeActionResponse>;
}

interface ActiveOwner {
  readonly token: symbol;
  readonly definition: MinorModeOwnerDefinition<DoomExtensionContext>;
  record: MinorModeRecord;
  readonly operations: Set<AbortController>;
}

interface PendingOperation {
  readonly requesterSource: string;
  readonly request: MinorModeActionRequest;
  readonly promise: Promise<MinorModeActionResponse>;
}

function protocolError(code: string, message: string, retryable = false): DoomProtocolError {
  return new DoomProtocolError({ code, message, retryable });
}

function registrationRef(record: MinorModeRecord): MinorModeRegistrationRef {
  return {
    source: record.descriptor.source,
    id: record.descriptor.id,
    ownerGeneration: record.ownerGeneration,
    registrationId: record.registrationId,
  };
}

function sameRegistration(record: MinorModeRecord, ref: MinorModeRegistrationRef): boolean {
  return (
    record.descriptor.source === ref.source &&
    record.descriptor.id === ref.id &&
    record.ownerGeneration === ref.ownerGeneration &&
    record.registrationId === ref.registrationId
  );
}

function sameRequest(left: MinorModeActionRequest, right: MinorModeActionRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function abortError(signal: AbortSignal): DoomProtocolError {
  const timeout = signal.reason === 'minor-mode-timeout';
  return protocolError(
    timeout ? MINOR_MODE_ERROR_CODE.actionTimeout : MINOR_MODE_ERROR_CODE.actionAborted,
    timeout ? 'Minor-mode action timed out.' : 'Minor-mode action was aborted.',
    timeout,
  );
}

async function runAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError(signal));
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

export function createMinorModeCatalogHost<ExtensionContext extends DoomExtensionContext>(
  options: MinorModeCatalogHostOptions<ExtensionContext>,
): MinorModeCatalogService {
  const generation = `${MINOR_MODE_CATALOG_SOURCE}:${crypto.randomUUID()}`;
  const actionTimeoutMs = options.actionTimeoutMs ?? MINOR_MODE_ACTION_TIMEOUT_MS;
  const owners = new Map<string, ActiveOwner>();
  const activeByMode = new Map<string, string>();
  const pending = new Map<string, PendingOperation>();
  const listeners = new Set<() => void>();
  const restoreTimers = new Set<ReturnType<typeof setTimeout>>();
  const restoreRecords = new Map<string, MinorModeRecord>(
    (options.restoreSnapshot?.modes ?? [])
      .filter(({ state }) => state.activation === 'active' || state.activation === 'activating')
      .map((record) => [minorModeKey(record.descriptor), structuredClone(record)]),
  );
  let revision = 0;
  let disposed = false;

  const notify = (): void => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  const snapshot = (): MinorModeCatalogSnapshot => ({
    hostGeneration: generation,
    revision,
    modes: [...owners.values()]
      .map(({ record }) => structuredClone(record))
      .toSorted(
        (left, right) =>
          left.descriptor.order - right.descriptor.order ||
          left.descriptor.source.localeCompare(right.descriptor.source) ||
          left.descriptor.id.localeCompare(right.descriptor.id),
      ),
  });

  const invokeOwner = async (
    owner: ActiveOwner,
    request: MinorModeActionRequest,
    signal: AbortSignal,
  ): Promise<MinorModeActionResponse> => {
    const action = owner.record.descriptor.actions.find(({ id }) => id === request.actionId);
    const availability = owner.record.state.actions.find(({ id }) => id === request.actionId);
    if (!action) {
      throw protocolError(
        MINOR_MODE_ERROR_CODE.actionNotFound,
        `Minor mode action '${request.actionId}' was not found.`,
      );
    }
    if (!availability?.enabled) {
      throw protocolError(
        MINOR_MODE_ERROR_CODE.actionDisabled,
        availability?.disabledReason ?? `Minor mode action '${request.actionId}' is disabled.`,
      );
    }
    if (!action.contexts.includes(options.sessionKind)) {
      throw protocolError(
        MINOR_MODE_ERROR_CODE.unsupportedContext,
        `Action '${action.id}' is unavailable in ${options.sessionKind} sessions.`,
      );
    }
    validateMinorModeActionArguments(action, request.arguments);
    try {
      const result = await runAbortable(
        Promise.resolve(
          owner.definition.handleAction(request.actionId, structuredClone(request.arguments), {
            context: options.context,
            operationId: request.operationId,
            sessionKind: options.sessionKind,
            signal,
          }),
        ),
        signal,
      );
      const current = owners.get(minorModeKey(owner.record.descriptor));
      if (disposed || current !== owner) {
        throw protocolError(MINOR_MODE_ERROR_CODE.staleRegistration, 'Minor-mode owner was replaced.');
      }
      return {
        operationId: request.operationId,
        catalogRevision: revision,
        mode: structuredClone(owner.record),
        ...(result?.message ? { message: result.message } : {}),
      };
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (error instanceof DoomProtocolError) throw error;
      owner.definition.onError?.(error);
      throw protocolError(MINOR_MODE_ERROR_CODE.ownerFailed, error instanceof Error ? error.message : String(error));
    }
  };

  const invoke = (
    request: MinorModeActionRequest,
    requesterSource: string,
    signal?: AbortSignal,
  ): Promise<MinorModeActionResponse> => {
    if (disposed) {
      return Promise.reject(protocolError(MINOR_MODE_ERROR_CODE.sessionReplaced, 'Minor-mode catalog is disposed.'));
    }
    const terminal = pending.get(request.operationId);
    if (terminal) {
      if (terminal.requesterSource !== requesterSource || !sameRequest(terminal.request, request)) {
        return Promise.reject(
          protocolError(MINOR_MODE_ERROR_CODE.registrationConflict, 'Minor-mode operation id was reused.'),
        );
      }
      return terminal.promise;
    }
    const key = minorModeKey(request.mode);
    const owner = owners.get(key);
    if (!owner || !sameRegistration(owner.record, request.mode)) {
      return Promise.reject(protocolError(MINOR_MODE_ERROR_CODE.modeNotFound, 'Minor mode is unavailable.'));
    }
    if (activeByMode.has(key)) {
      return Promise.reject(protocolError(MINOR_MODE_ERROR_CODE.modeBusy, 'Minor mode already has an active action.'));
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort('minor-mode-timeout'), actionTimeoutMs);
    owner.operations.add(controller);
    activeByMode.set(key, request.operationId);
    const direct = () => invokeOwner(owner, request, controller.signal);
    const promise = Promise.resolve(
      options.routeInvocation ? options.routeInvocation(request, requesterSource, direct) : direct(),
    ).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      owner.operations.delete(controller);
      if (activeByMode.get(key) === request.operationId) activeByMode.delete(key);
      pending.delete(request.operationId);
    });
    pending.set(request.operationId, { requesterSource, request: structuredClone(request), promise });
    return promise;
  };

  const scheduleRestoration = (owner: ActiveOwner): void => {
    const key = minorModeKey(owner.record.descriptor);
    const previous = restoreRecords.get(key);
    restoreRecords.delete(key);
    if (!previous) return;
    const timer = setTimeout(() => {
      restoreTimers.delete(timer);
      if (disposed || owners.get(key) !== owner || owner.record.state.activation === 'active') return;
      const action = owner.record.descriptor.actions.find(({ id }) => id === 'activate');
      const availability = owner.record.state.actions.find(({ id }) => id === 'activate');
      if (!action || action.parameters.some(({ required }) => required) || !availability?.enabled) return;
      void invoke(
        {
          operationId: `minor-mode-restore:${crypto.randomUUID()}`,
          mode: registrationRef(owner.record),
          actionId: 'activate',
          arguments: {},
        },
        MINOR_MODE_CATALOG_SOURCE,
      ).catch((error: unknown) => {
        if (options.onRestorationError) options.onRestorationError(error);
        else
          queueMicrotask(() => {
            throw error instanceof Error ? error : new Error(String(error));
          });
      });
    }, 0);
    restoreTimers.add(timer);
  };

  return {
    generation,
    getSnapshot: snapshot,
    list: () => snapshot().modes,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    registerOwner(definition) {
      if (disposed) throw protocolError(MINOR_MODE_ERROR_CODE.sessionReplaced, 'Minor-mode catalog is disposed.');
      if (owners.size >= MINOR_MODE_MAX_RECORDS) {
        throw protocolError(MINOR_MODE_ERROR_CODE.registrationConflict, 'Minor-mode catalog capacity reached.');
      }
      const initialState = structuredClone(definition.initialState);
      const invalid = validateMinorModeDefinition(definition.descriptor, initialState);
      if (invalid) throw protocolError(MINOR_MODE_ERROR_CODE.registrationConflict, invalid);
      const key = minorModeKey(definition.descriptor);
      if (owners.has(key)) {
        throw protocolError(
          MINOR_MODE_ERROR_CODE.registrationConflict,
          `Minor mode '${definition.descriptor.source}/${definition.descriptor.id}' already has a live owner.`,
        );
      }
      const owner: ActiveOwner = {
        token: Symbol(key),
        definition: definition as unknown as MinorModeOwnerDefinition<DoomExtensionContext>,
        operations: new Set(),
        record: {
          descriptor: structuredClone(definition.descriptor),
          state: initialState,
          ownerGeneration: `${key}:${crypto.randomUUID()}`,
          registrationId: `minor-mode-registration:${crypto.randomUUID()}`,
          stateRevision: 0,
        },
      };
      owners.set(key, owner);
      notify();
      scheduleRestoration(owner);
      let ownerDisposed = false;
      const handle: MinorModeOwnerHandle = {
        getState: () => structuredClone(owner.record.state),
        publish(state) {
          if (ownerDisposed || owners.get(key) !== owner) return;
          const validation = validateMinorModeDefinition(owner.record.descriptor, state);
          if (validation) throw new Error(validation);
          owner.record = {
            ...owner.record,
            state: structuredClone(state),
            stateRevision: owner.record.stateRevision + 1,
          };
          notify();
        },
        dispose() {
          if (ownerDisposed) return;
          ownerDisposed = true;
          if (owners.get(key) !== owner) return;
          for (const controller of owner.operations) controller.abort('minor-mode-owner-disposed');
          owner.operations.clear();
          owners.delete(key);
          notify();
        },
      };
      return handle;
    },
    invoke,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of restoreTimers) clearTimeout(timer);
      restoreTimers.clear();
      for (const owner of owners.values()) {
        for (const controller of owner.operations) controller.abort('minor-mode-catalog-disposed');
        owner.operations.clear();
      }
      owners.clear();
      pending.clear();
      activeByMode.clear();
      restoreRecords.clear();
      notify();
      listeners.clear();
    },
  };
}
