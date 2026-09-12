import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';

/** Cordis service that owns pull-based background-work contributions for Pi sessions. */
export const DOOM_BACKGROUND_WORK_SERVICE = 'doom/background-work';
/**
 * Snapshot invalidation only. Consumers must reread the authoritative service snapshot
 * and must not infer current work from the event payload.
 */
export const DOOM_BACKGROUND_WORK_CHANGED_EVENT = 'doom/background-work/changed';

export const BackgroundProviderWorkItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String({ minLength: 1 })),
    status: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type BackgroundProviderWorkItem = Static<typeof BackgroundProviderWorkItemSchema>;

export const BackgroundWorkItemSchema = Type.Object(
  { ...BackgroundProviderWorkItemSchema.properties, provider: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type BackgroundWorkItem = Static<typeof BackgroundWorkItemSchema>;

export interface BackgroundWorkProvider {
  readonly provider: string;
  /**
   * Returns the current authoritative work set. Items must use their owning Pi session ID.
   * Publish work before releasing asynchronous launch ownership, and retain terminal items
   * until Pi accepts their completion handoff or a durable fallback owns delivery.
   */
  listActiveWork(): readonly BackgroundProviderWorkItem[];
}

export interface BackgroundWorkProviderHandle {
  readonly provider: string;
  readonly generation: string;
  /** Announces that the provider's pull-based snapshot changed. This carries no snapshot state. */
  update(): void;
  dispose(): void;
}

export interface DoomBackgroundWorkSnapshot {
  readonly items: readonly BackgroundWorkItem[];
  readonly errors: readonly { readonly provider: string; readonly message: string }[];
}

export interface DoomBackgroundWorkChanged {
  readonly provider: string;
  readonly generation: string;
  readonly kind: 'registered' | 'updated' | 'unregistered';
}

export interface DoomBackgroundWorkService {
  /** Changes when the owning coordination service is replaced. */
  readonly generation: string;
  register(provider: BackgroundWorkProvider): BackgroundWorkProviderHandle;
  /** Returns an authoritative snapshot, filtered to an exact session when supplied. */
  snapshot(sessionId?: string): DoomBackgroundWorkSnapshot;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/background-work': DoomBackgroundWorkService;
  }

  interface Events {
    'doom/background-work/changed'(event: DoomBackgroundWorkChanged): void;
  }
}

/** Reads the active host-owned background-work coordination service. */
export function readDoomBackgroundWorkService(ctx: Context): DoomBackgroundWorkService | undefined {
  return ctx.get(DOOM_BACKGROUND_WORK_SERVICE) as DoomBackgroundWorkService | undefined;
}
