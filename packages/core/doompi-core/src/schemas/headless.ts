import type { Context } from '@deepseek-ai/cordis';
import type { Static, TSchema } from 'typebox';

import type { DoomNotificationRequest } from './notification';
import type { DoomServerBundleEntry } from './serverBundle';

/** Session-only contributions. This is not a Pi ExtensionAPI or a TUI adapter. */
export const DOOM_HEADLESS_HOST_SERVICE = 'doom/headless-host';
export const DOOM_HEADLESS_OWNER = Symbol.for('doom/headless-owner');

export interface DoomHeadlessSelection {
  readonly majorMode: string;
  readonly activeLayers: readonly string[];
  readonly domains: readonly string[];
  readonly profile?: string;
  /** Feature-owned activation sets, keyed by the contributing capability. */
  readonly state?: Readonly<Record<string, readonly string[]>>;
}

/** One package-owned selection transition. Server facets change exactly one axis per operation. */
export type DoomHeadlessSelectionChange =
  | { readonly axis: 'majorMode'; readonly majorMode: string }
  | { readonly axis: 'domains'; readonly domains: readonly string[] }
  | { readonly axis: 'profile'; readonly profile?: string }
  | { readonly axis: 'state'; readonly key: string; readonly values: readonly string[] };

export function readDoomHeadlessOwner(context: Context): DoomServerBundleEntry | undefined {
  return (context as Context & { [DOOM_HEADLESS_OWNER]?: DoomServerBundleEntry })[DOOM_HEADLESS_OWNER];
}

export interface DoomHeadlessRegistration {
  dispose(): void;
}

export type DoomHeadlessContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface DoomHeadlessToolResult {
  content: DoomHeadlessContent[];
  details?: unknown;
  isError?: boolean;
}

export interface DoomHeadlessClientRequest {
  kind: 'confirm' | 'select' | 'input';
  title: string;
  message?: string;
  options?: readonly { label: string; description?: string; value: string }[];
  initialValue?: string;
  multiline?: boolean;
}

export interface DoomHeadlessClient {
  notify(request: DoomNotificationRequest): void | Promise<void>;
  request(request: DoomHeadlessClientRequest, signal?: AbortSignal): Promise<unknown>;
  setStatus(source: string, text: string | undefined): void;
  appendComposerText?(text: string): void;
}

export interface DoomHeadlessSession {
  /** Query durable history on demand; hosts do not retain the entire transcript. */
  entries(query?: {
    type?: 'custom' | 'message';
    customType?: string;
    limit?: number;
  }): readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>;
  appendCustomEntry(type: string, data: unknown): Promise<void>;
  prompt(text: string, delivery?: 'prompt' | 'steer' | 'followUp'): Promise<void>;
  /** Resolves when accepted by the session, before the agent turn settles. */
  admitPrompt?(text: string, delivery?: 'prompt' | 'steer' | 'followUp'): Promise<void>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  activity(): Promise<{ hasPendingMessages: boolean; isIdle: boolean }>;
}

export interface DoomHeadlessExecutionContext {
  readonly cwd: string;
  /** Admitted configuration root, distinct from the tool execution directory. */
  readonly repoRoot: string;
  readonly sessionId: string;
  /** Immutable session configuration. Facets must not read or mutate process.env. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly client: DoomHeadlessClient;
  readonly session: DoomHeadlessSession;
  readonly model?: { provider: string; id: string };
  readonly textCompletion?: {
    available(reference: string): boolean;
    complete(
      reference: string,
      request: {
        systemPrompt: string;
        input: string;
        maxTokens: number;
        cacheRetention?: 'none' | 'short' | 'long';
        signal?: AbortSignal;
      },
    ): Promise<string>;
  };
  readonly selection: DoomHeadlessSelection;
  shutdown(): void;
}

/** Conditions narrow an eligible owner's contributions; they can never restore a disabled owner. */
export interface DoomHeadlessCondition {
  state?: Readonly<Record<string, string>>;
  attribution?: { kind: 'minor' | 'domain'; mode: string; label?: string };
  domain?: string;
}

export interface DoomHeadlessToolRestriction {
  when?: DoomHeadlessCondition;
  allowedTools: readonly string[];
}

export interface DoomHeadlessTool<TParameters extends TSchema = TSchema> {
  when?: DoomHeadlessCondition;
  name: string;
  label?: string;
  description: string;
  parameters: TParameters;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  executionMode?: 'parallel' | 'serial';
  execute(
    toolCallId: string,
    parameters: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: DoomHeadlessToolResult) => void) | undefined,
    context: DoomHeadlessExecutionContext,
  ): Promise<DoomHeadlessToolResult>;
}

export interface DoomHeadlessResource {
  when?: DoomHeadlessCondition;
  name: string;
  kind: 'prompt' | 'skill' | 'context';
  read(context: DoomHeadlessExecutionContext): string | Promise<string>;
}

export interface DoomHeadlessCommand {
  when?: DoomHeadlessCondition;
  name: string;
  description: string;
  execute(args: string, context: DoomHeadlessExecutionContext): void | Promise<void>;
}

export type DoomHeadlessEventName =
  | 'session_start'
  | 'session_shutdown'
  | 'session_tree'
  | 'before_agent_start'
  | 'agent_start'
  | 'agent_settled'
  | 'turn_start'
  | 'turn_end'
  | 'context'
  | 'before_provider_request'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'tool_call'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'
  | 'tool_result'
  | 'model_select'
  | 'session_before_compact'
  | 'session_compact';

export type DoomHeadlessHookEvent<E extends DoomHeadlessEventName> = E extends 'before_provider_request'
  ? { lane: string; runId: string; model: { provider: string; id: string }; payload: unknown }
  : E extends 'session_before_compact'
    ? { reason: string; preparation: unknown; instructions?: string; customInstructions?: string }
    : E extends 'model_select'
      ? { model: { provider: string; id: string } }
      : Readonly<Record<string, unknown>>;

export interface DoomHeadlessCompactionResult {
  summary: string;
  tokensBefore: number;
  retainedTail: Record<string, unknown>[];
  usage?: Record<string, unknown>;
  details?: unknown;
}

export type DoomHeadlessHookResult<E extends DoomHeadlessEventName> = E extends 'before_provider_request'
  ? { payload: unknown } | void
  : E extends 'session_before_compact'
    ? { cancel?: boolean; decline?: boolean; compaction?: DoomHeadlessCompactionResult } | void
    : E extends 'context'
      ? { messages?: unknown[]; systemPrompt?: string } | void
      : E extends 'before_agent_start'
        ? { systemPrompt?: string } | void
        : E extends 'tool_call'
          ? { args?: Record<string, unknown>; block?: { reason: string; terminate?: boolean } } | void
          : E extends 'tool_result'
            ? {
                content?: DoomHeadlessContent[];
                details?: unknown;
                isError?: boolean;
                usage?: Record<string, unknown>;
                terminate?: boolean;
              } | void
            : unknown;

export type DoomHeadlessHook<E extends DoomHeadlessEventName = DoomHeadlessEventName> = E extends DoomHeadlessEventName
  ? {
      when?: DoomHeadlessCondition;
      event: E;
      handle(
        event: Readonly<DoomHeadlessHookEvent<E>>,
        context: DoomHeadlessExecutionContext,
      ): DoomHeadlessHookResult<E> | Promise<DoomHeadlessHookResult<E>>;
    }
  : never;

/** A retained facet can register activity without starting disabled watchers or services. */
export interface DoomHeadlessActivity {
  when?: DoomHeadlessCondition;
  name: string;
  start(context: DoomHeadlessExecutionContext): (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
}

/** Registrations inherit package ownership from the caller's Cordis facet. */
export interface DoomHeadlessHostService {
  readonly context: DoomHeadlessExecutionContext;
  changeSelection(change: DoomHeadlessSelectionChange): Promise<void>;
  assertActive(source?: string): void;
  subscribeSelection(listener: (selection: DoomHeadlessSelection) => void | Promise<void>): () => void;
  registerToolRestriction(restriction: DoomHeadlessToolRestriction): DoomHeadlessRegistration;
  registerTool<TParameters extends TSchema>(tool: DoomHeadlessTool<TParameters>): DoomHeadlessRegistration;
  registerResource(resource: DoomHeadlessResource): DoomHeadlessRegistration;
  registerCommand(command: DoomHeadlessCommand): DoomHeadlessRegistration;
  registerHook(hook: DoomHeadlessHook): DoomHeadlessRegistration;
  registerActivity(activity: DoomHeadlessActivity): DoomHeadlessRegistration;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/headless-host': DoomHeadlessHostService;
  }
}

export function readDoomHeadlessHost(context: Context): DoomHeadlessHostService | undefined {
  return context.get(DOOM_HEADLESS_HOST_SERVICE) as DoomHeadlessHostService | undefined;
}

export function requireDoomHeadlessHost(context: Context): DoomHeadlessHostService {
  const host = readDoomHeadlessHost(context);
  if (!host) throw new Error('This contribution requires the Doom headless session host.');
  return host;
}
