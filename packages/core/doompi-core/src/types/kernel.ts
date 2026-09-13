/**
 * Kernel contribution contracts.
 *
 * DESIGN PATTERNS:
 * - One concept: a slot. Tools, commands, resources and hooks are all slots,
 *   so a new surface costs a `defineSlot` call rather than a new registry.
 * - Contributions are gated by the layer that owns them. A layer is the unit a
 *   major mode selects, so recomputing the active union is the whole of a
 *   major-mode switch.
 * - Sinks receive the complete active list, never a delta. Whole-list
 *   replacement makes removal inherent, which is what lets a switch take
 *   effect without tearing the process down.
 *
 * AVOID:
 * - Host types in this file. The kernel is host-neutral so the Pi facet and
 *   the headless server facet can share one registry.
 * - Mutating a contribution after registration. Re-register instead, so the
 *   recomputed union stays a pure function of the registered set.
 */

/** A contribution the kernel may hand to a sink. */
export interface KernelContribution<TValue> {
  /** Owning package, for diagnostics and for `contributionsOf`. */
  readonly source: string;
  /**
   * Layer that must be active for this contribution to apply. Omitted means
   * always active, which is how host-owned contributions opt out of gating.
   */
  readonly layer?: string;
  readonly value: TValue;
}

/** Receives the complete active list for one slot whenever it changes. */
export type KernelSlotSink<TValue> = (active: readonly TValue[]) => void | Promise<void>;

/** Removes a contribution or a slot. Calling it twice is a no-op. */
export interface KernelRegistration {
  dispose(): void;
}

export interface KernelSlotHandle<TValue> extends KernelRegistration {
  readonly name: string;
  /** Registers a contribution against this slot without naming it again. */
  contribute(entry: KernelContribution<TValue>): KernelRegistration;
}

export interface DoomKernel {
  /** Layers currently selected by the active major mode. */
  readonly activeLayers: readonly string[];
  /** Slot names defined so far, in definition order. */
  readonly slots: readonly string[];
  defineSlot<TValue>(name: string, sink: KernelSlotSink<TValue>): KernelSlotHandle<TValue>;
  contribute<TValue>(slot: string, entry: KernelContribution<TValue>): KernelRegistration;
  /**
   * Replaces the active layer set and pushes every affected slot.
   *
   * Overlapping calls coalesce: a host converges on the last layer set rather
   * than replaying each one, so tapping through modes costs one apply.
   */
  setActiveLayers(layers: readonly string[]): Promise<void>;
  /**
   * Re-pushes a slot whose contribution values now render differently, such as
   * resources after a domain change. Omit the name to push every slot.
   */
  refresh(slot?: string): Promise<void>;
  /** Active values for one slot, in registration order. Empty if undefined. */
  activeValues<TValue>(slot: string): readonly TValue[];
  /** All registered contributions for one slot, including inactive layers. */
  contributions<TValue>(slot: string): readonly KernelContribution<TValue>[];
  dispose(): void;
}
