/**
 * The kernel contribution registry.
 *
 * DESIGN PATTERNS:
 * - Pure function of registered contributions plus the active layer set. Every
 *   push recomputes from that state, so there is no incremental bookkeeping to
 *   drift out of sync.
 * - Pushes are serialized on one tail. A sink that awaits cannot interleave
 *   with the next recompute, which is what keeps a host's whole-list setter
 *   from being called out of order.
 * - Registration coalesces into one microtask flush, so composing forty
 *   packages at startup costs one push per slot rather than forty.
 *
 * AVOID:
 * - Pushing a slot whose active list is unchanged. Hosts treat a set call as a
 *   structural change, and a redundant one is visible to the user.
 * - Throwing out of a push loop early. One broken sink must not stop the rest
 *   of the surfaces from reaching the host.
 */

import type {
  DoomKernel,
  KernelContribution,
  KernelRegistration,
  KernelSlotHandle,
  KernelSlotSink,
} from '../types/kernel.ts';

interface SlotState {
  readonly name: string;
  readonly sink: KernelSlotSink<unknown>;
  readonly entries: Map<number, KernelContribution<unknown>>;
  pushed: readonly unknown[] | undefined;
  disposed: boolean;
}

const DISPOSED_MESSAGE = 'The kernel is disposed';

function sameList(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
  if (left === undefined || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CreateDoomKernelOptions {
  /** Layers active at creation, usually `resolveLayers(config, majorMode)`. */
  readonly activeLayers?: readonly string[];
}

export function createDoomKernel(options: CreateDoomKernelOptions = {}): DoomKernel {
  const slots = new Map<string, SlotState>();
  const dirty = new Set<string>();
  /** Slots whose values render differently without the list itself changing. */
  const forced = new Set<string>();
  let layers = new Set(options.activeLayers ?? []);
  let sequence = 0;
  let tail: Promise<void> = Promise.resolve();
  let scheduled: Promise<void> | undefined;
  let disposed = false;

  const activeOf = (slot: SlotState): readonly unknown[] =>
    [...slot.entries.entries()]
      .sort(([left], [right]) => left - right)
      .filter(([, entry]) => entry.layer === undefined || layers.has(entry.layer))
      .map(([, entry]) => entry.value);

  const pushOne = async (slot: SlotState, force: boolean, failures: string[]): Promise<void> => {
    if (slot.disposed) return;
    const active = activeOf(slot);
    if (!force && sameList(slot.pushed, active)) return;
    try {
      await slot.sink(active);
      slot.pushed = active;
    } catch (error) {
      // Cache only an acknowledged application. A sink may be retried with the
      // same active values after it recovers.
      failures.push(`${slot.name}: ${describe(error)}`);
    }
  };

  const flush = (): Promise<void> => {
    const run = tail
      .catch(() => undefined)
      .then(async () => {
        if (dirty.size === 0) return;
        const pending = [...dirty];
        const pendingForced = new Set(forced);
        dirty.clear();
        forced.clear();
        const failures: string[] = [];
        for (const name of pending) {
          const slot = slots.get(name);
          if (slot) await pushOne(slot, pendingForced.has(name), failures);
        }
        if (failures.length > 0) throw new Error(`Kernel slots failed to apply: ${failures.join('; ')}`);
      });
    tail = run;
    return run;
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = Promise.resolve().then(() => {
      scheduled = undefined;
      // A scheduled flush is fire and forget; `refresh` is how a caller waits.
      return flush().catch(() => undefined);
    });
  };

  const markDirty = (name: string): void => {
    dirty.add(name);
  };

  const contribute = <TValue>(slot: string, entry: KernelContribution<TValue>): KernelRegistration => {
    if (disposed) throw new Error(DISPOSED_MESSAGE);
    const state = slots.get(slot);
    if (!state)
      throw new Error(`Unknown kernel slot: ${slot}. Defined slots: ${[...slots.keys()].join(', ') || 'none'}`);
    const key = sequence++;
    state.entries.set(key, entry as KernelContribution<unknown>);
    markDirty(slot);
    schedule();
    let removed = false;
    return {
      dispose(): void {
        if (removed) return;
        removed = true;
        state.entries.delete(key);
        markDirty(slot);
        schedule();
      },
    };
  };

  return {
    get activeLayers(): readonly string[] {
      return [...layers];
    },
    get slots(): readonly string[] {
      return [...slots.keys()];
    },
    defineSlot<TValue>(name: string, sink: KernelSlotSink<TValue>): KernelSlotHandle<TValue> {
      if (disposed) throw new Error(DISPOSED_MESSAGE);
      if (slots.has(name)) throw new Error(`Kernel slot already defined: ${name}`);
      const state: SlotState = {
        name,
        sink: sink as KernelSlotSink<unknown>,
        entries: new Map(),
        pushed: undefined,
        disposed: false,
      };
      slots.set(name, state);
      let removed = false;
      return {
        name,
        contribute: (entry) => contribute(name, entry),
        dispose(): void {
          if (removed) return;
          removed = true;
          state.disposed = true;
          slots.delete(name);
          dirty.delete(name);
          forced.delete(name);
        },
      };
    },
    contribute,
    async setActiveLayers(next: readonly string[]): Promise<void> {
      if (disposed) throw new Error(DISPOSED_MESSAGE);
      layers = new Set(next);
      for (const name of slots.keys()) markDirty(name);
      await flush();
    },
    async refresh(slot?: string): Promise<void> {
      if (disposed) throw new Error(DISPOSED_MESSAGE);
      if (slot === undefined) {
        for (const name of slots.keys()) {
          markDirty(name);
          forced.add(name);
        }
      } else if (slots.has(slot)) {
        markDirty(slot);
        forced.add(slot);
      }
      await flush();
    },
    activeValues<TValue>(slot: string): readonly TValue[] {
      const state = slots.get(slot);
      return state ? (activeOf(state) as readonly TValue[]) : [];
    },
    contributions<TValue>(slot: string): readonly KernelContribution<TValue>[] {
      const state = slots.get(slot);
      return state ? ([...state.entries.values()] as readonly KernelContribution<TValue>[]) : [];
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const state of slots.values()) state.disposed = true;
      slots.clear();
      dirty.clear();
    },
  };
}
