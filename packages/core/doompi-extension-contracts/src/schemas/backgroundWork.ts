import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';

/** Cordis service that owns the session's background-work contributions. */
export const DOOM_BACKGROUND_WORK_SERVICE = 'doom/background-work';
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
  listActiveWork(): readonly BackgroundProviderWorkItem[];
}

export interface BackgroundWorkProviderHandle {
  readonly provider: string;
  readonly generation: string;
  /** Announces that the provider's pull-based snapshot changed. */
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
  readonly generation: string;
  register(provider: BackgroundWorkProvider): BackgroundWorkProviderHandle;
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

/** Reads the provider owned by the active Team session. */
export function readDoomBackgroundWorkService(ctx: Context): DoomBackgroundWorkService | undefined {
  return ctx.get(DOOM_BACKGROUND_WORK_SERVICE) as DoomBackgroundWorkService | undefined;
}
