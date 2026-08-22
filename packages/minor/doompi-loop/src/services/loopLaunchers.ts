import type {
  DoomLoopLaunchersService,
  LoopInstanceSnapshot,
  LoopLauncherDefinition,
  LoopLauncherRegistration,
  StoppableLoop,
} from '@agimon-ai/doompi-extension-contracts/loop-launchers';

const MAX_ID_LENGTH = 256;
const MAX_GENERATION_LENGTH = 256;
const LAUNCHER_ID_LABEL = 'loop launcher id';
const INSTANCE_ID_LABEL = 'loop instance id';

interface LauncherEntry {
  readonly token: symbol;
  readonly definition: LoopLauncherDefinition;
}

interface InstanceEntry {
  readonly instanceId: string;
  readonly launcher: LauncherEntry;
  readonly abortController: AbortController;
  state: LoopInstanceSnapshot['state'];
  handle?: StoppableLoop;
  startedAt?: string;
}

export interface LoopLaunchersDependencies {
  readonly generation: string;
  readonly createInstanceId: () => string;
  readonly timestamp: () => string;
}

function validId(value: string, label: string): string {
  const normalized = value.trim();
  let hasControl = false;
  for (const character of normalized) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      hasControl = true;
      break;
    }
  }
  if (!normalized || normalized.length > MAX_ID_LENGTH || hasControl) throw new Error(`Invalid ${label}.`);
  return normalized;
}

function snapshot(entry: InstanceEntry): LoopInstanceSnapshot {
  return {
    instanceId: entry.instanceId,
    launcherId: entry.launcher.definition.id,
    launcherLabel: entry.launcher.definition.label,
    ...(entry.handle?.label ? { label: entry.handle.label } : {}),
    ...(entry.handle?.detail ? { detail: entry.handle.detail } : {}),
    state: entry.state,
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
  };
}

/** Creates the provider-owned launcher registry for one active Doom session. */
export function createDoomLoopLaunchersService({
  generation,
  createInstanceId,
  timestamp,
}: LoopLaunchersDependencies): DoomLoopLaunchersService {
  if (!generation || generation.length > MAX_GENERATION_LENGTH) {
    throw new TypeError('Doom loop launchers require a valid generation.');
  }

  const launchers = new Map<string, LauncherEntry>();
  const instances = new Map<string, InstanceEntry>();
  const listeners = new Set<() => void>();
  let registrationSequence = 0;
  let disposed = false;

  const ensureActive = (): void => {
    if (disposed) throw new Error('The Doom loop-launchers service is disposed.');
  };
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const stopEntry = async (entry: InstanceEntry, reason?: string): Promise<void> => {
    if (instances.get(entry.instanceId) !== entry) return;
    entry.state = 'stopping';
    entry.abortController.abort(reason);
    notify();
    try {
      await entry.handle?.stop(reason);
    } finally {
      if (instances.get(entry.instanceId) === entry) instances.delete(entry.instanceId);
      notify();
    }
  };

  const service: DoomLoopLaunchersService = {
    generation,
    register(definition): LoopLauncherRegistration {
      ensureActive();
      const id = validId(definition.id, LAUNCHER_ID_LABEL);
      if (launchers.has(id)) throw new Error(`Loop launcher '${id}' is already registered.`);
      const token = Symbol(id);
      const entry: LauncherEntry = { token, definition: { ...definition, id } };
      launchers.set(id, entry);
      registrationSequence += 1;
      notify();
      let registrationDisposed = false;
      return Object.freeze({
        id,
        generation: `${generation}:launcher:${registrationSequence}`,
        async dispose(reason = 'Loop launcher disposed.'): Promise<void> {
          if (registrationDisposed) return;
          registrationDisposed = true;
          if (launchers.get(id)?.token !== token) return;
          launchers.delete(id);
          const owned = [...instances.values()].filter((instance) => instance.launcher.token === token);
          await Promise.allSettled(owned.map((instance) => stopEntry(instance, reason)));
          notify();
        },
      });
    },
    listLaunchers() {
      ensureActive();
      return [...launchers.values()]
        .map(({ definition }) => ({
          id: definition.id,
          source: definition.source,
          label: definition.label,
          ...(definition.description ? { description: definition.description } : {}),
        }))
        .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    },
    listInstances() {
      ensureActive();
      return [...instances.values()]
        .map(snapshot)
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    },
    subscribe(listener) {
      ensureActive();
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    async launch(launcherId, options) {
      ensureActive();
      const normalizedLauncherId = validId(launcherId, LAUNCHER_ID_LABEL);
      const launcher = launchers.get(normalizedLauncherId);
      if (!launcher) throw new Error(`Loop launcher '${normalizedLauncherId}' is unavailable.`);
      const instanceId = validId(options?.instanceId ?? createInstanceId(), INSTANCE_ID_LABEL);
      if (instances.has(instanceId)) throw new Error(`Loop instance '${instanceId}' already exists.`);
      const entry: InstanceEntry = { instanceId, launcher, abortController: new AbortController(), state: 'starting' };
      instances.set(instanceId, entry);
      notify();
      try {
        const handle = await launcher.definition.launch({ instanceId, signal: entry.abortController.signal });
        const active = !disposed && instances.get(instanceId) === entry && !entry.abortController.signal.aborted;
        if (!handle) {
          if (instances.get(instanceId) === entry) instances.delete(instanceId);
          notify();
          return undefined;
        }
        if (!active || handle.instanceId !== instanceId) {
          await handle.stop(active ? 'Loop launcher returned a mismatched instance id.' : 'Loop launch was cancelled.');
          if (instances.get(instanceId) === entry) instances.delete(instanceId);
          notify();
          if (active) throw new Error(`Loop launcher '${normalizedLauncherId}' returned a mismatched instance id.`);
          return undefined;
        }
        entry.handle = handle;
        entry.state = 'running';
        entry.startedAt = timestamp();
        notify();
        return snapshot(entry);
      } catch (error) {
        const cancelled = entry.abortController.signal.aborted || disposed;
        if (instances.get(instanceId) === entry) instances.delete(instanceId);
        notify();
        if (cancelled) return undefined;
        throw error;
      }
    },
    async stop(instanceId, reason) {
      ensureActive();
      const entry = instances.get(validId(instanceId, INSTANCE_ID_LABEL));
      if (!entry) return false;
      await stopEntry(entry, reason);
      return true;
    },
    async stopAll(reason) {
      if (disposed && instances.size === 0) return;
      await Promise.allSettled([...instances.values()].map((entry) => stopEntry(entry, reason)));
    },
    async dispose(reason = 'Doom loop-launchers service disposed.') {
      if (disposed) return;
      disposed = true;
      launchers.clear();
      await Promise.allSettled([...instances.values()].map((entry) => stopEntry(entry, reason)));
      listeners.clear();
    },
  };

  return Object.freeze(service);
}
