import type { DoomConfigContext } from '@agimon-ai/doompi-config/types';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { HookDocumentReader, HookRunner } from '../../types/hooks';
import type { HookTelemetry } from '../../types/telemetry';
export interface HookExtensionOptions {
  telemetry?: HookTelemetry;
  runner?: HookRunner;
  documents?: HookDocumentReader;
}

/** The two collaborators a dispatch needs, both replaceable in tests. */
export interface HookSession {
  config(): DoomConfigContext;
  runner: HookRunner;
  documents: HookDocumentReader;
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
  isCurrent(): boolean;
}

export type HookRuntimeResolver = () => HookRuntime | undefined;

export interface HookRuntimeBinding extends HookRuntime {
  dispose(): void;
}
export interface HookBinding {
  readonly plugin: (this: void, context: Context) => void;
  readonly runtime: HookRuntimeResolver;
}
