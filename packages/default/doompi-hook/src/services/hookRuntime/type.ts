import type { DoomConfigContext } from '@agimon-ai/doompi-config/types';
import type { DoomChildSessionHooks } from '@agimon-ai/doompi-core/childSession';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { HookContext } from '../../types/hookModule';
import type { HookDocumentReader, HookRunner } from '../../types/hooks';
import type { HookTelemetry } from '../../types/telemetry';
import type { HookModules } from '../hookModules/type';

export const DOOM_HOOK_SESSION_SERVICE = 'doom/hook-session';
export interface HookExtensionOptions {
  telemetry?: HookTelemetry;
  runner?: HookRunner;
  documents?: HookDocumentReader;
}

/** One host session owns its module registry and lifetime; children borrow only immutable config. */
export interface HookSession {
  config(): DoomConfigContext;
  prepare(isSubagent?: boolean): Promise<void>;
  readonly runner: HookRunner;
  readonly documents: HookDocumentReader;
  readonly modules: HookModules;
  readonly signal: AbortSignal;
  readonly parentContext?: Omit<HookContext, 'signal'>;
}

/** Package-scoped startup ordering supplied by the standard Pi adapter. */
export interface HookReadinessGate {
  start(
    context: ExtensionContext,
    operation: (signal: AbortSignal, isCurrent: () => boolean) => Promise<void>,
  ): void | Promise<void>;
  wait(context: ExtensionContext): Promise<void>;
}

/** One dependency-complete Hook runtime owned by a reactive Cordis fiber. */
export interface HookRuntime {
  readonly session: HookSession;
  readonly readiness?: HookReadinessGate;
  readonly childHooks: DoomChildSessionHooks;
  isCurrent(): boolean;
}

export type HookRuntimeResolver = () => HookRuntime | undefined;

export interface HookRuntimeBinding extends HookRuntime {
  dispose(): Promise<void>;
}
export interface HookBinding {
  readonly plugin: (this: void, context: Context) => void;
  readonly runtime: HookRuntimeResolver;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/hook-session': HookRuntime;
  }
}
