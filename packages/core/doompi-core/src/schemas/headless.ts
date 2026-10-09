import type { Context } from '@deepseek-ai/cordis';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import type { Static, TSchema } from 'typebox';

import type { SessionToolSurface } from '../types/server/sessionToolSurface';
import type { DoomSessionContext } from './hubChannel';
import type { DoomNotificationRequest } from './notification';
import type { DoomServerBundleEntry } from './serverBundle';

/** Session-only contributions. This is not a Pi ExtensionAPI or a TUI adapter. */
export const DOOM_HEADLESS_HOST_SERVICE = 'doom/headless-host';
export const DOOM_HEADLESS_OWNER = Symbol.for('doom/headless-owner');

const PROMPT_ADMISSION_ERROR = 'DoomHeadlessPromptAdmissionError';

/** Admission is a host boundary, not an advisory facet-hook failure. */
export class DoomHeadlessPromptAdmissionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = PROMPT_ADMISSION_ERROR;
  }
}

/** Error identity must survive independently bundled server and extension graphs. */
export function isDoomHeadlessPromptAdmissionError(error: unknown): boolean {
  return error instanceof Error && error.name === PROMPT_ADMISSION_ERROR;
}
const TOOL_BUSY_ERROR = 'DoomHeadlessToolBusyError';

/** The tool and its hooks have not started. */
export class DoomHeadlessToolBusyError extends Error {
  constructor() {
    super('An operation is already running');
    this.name = TOOL_BUSY_ERROR;
  }
}

export function isDoomHeadlessToolBusyError(error: unknown): boolean {
  return error instanceof Error && error.name === TOOL_BUSY_ERROR;
}

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
  /** Public MCP result data. Internal renderer details are not a remote result contract. */
  structuredContent?: Record<string, unknown>;
  /** Component-only MCP metadata, never inferred from internal renderer details. */
  _meta?: CallToolResult['_meta'];
  details?: unknown;
  isError?: boolean;
}

/**
 * Narrows a Pi tool result to the headless contract. Pi types `structuredContent` as any JSON
 * value, while MCP only accepts an object, so anything else is dropped rather than forwarded.
 */
export function toDoomHeadlessToolResult(result: {
  readonly content: DoomHeadlessContent[];
  readonly details?: unknown;
  readonly structuredContent?: unknown;
  readonly _meta?: CallToolResult['_meta'];
  readonly isError?: boolean;
}): DoomHeadlessToolResult {
  const { structuredContent } = result;
  return {
    content: result.content,
    details: result.details,
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
    ...(typeof structuredContent === 'object' && structuredContent !== null && !Array.isArray(structuredContent)
      ? { structuredContent: structuredContent as Record<string, unknown> }
      : {}),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
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
  /**
   * Operator-facing surface only: the body is flattened to one line and capped at 4096 characters
   * by schemas/notification.ts:73-83, and the model never sees it. Use session.admitPrompt to
   * reach the model.
   */
  notify(request: DoomNotificationRequest): void | Promise<void>;
  request(request: DoomHeadlessClientRequest, signal?: AbortSignal): Promise<unknown>;
  setStatus(source: string, text: string | undefined): void;
  appendComposerText?(text: string): void;
}

export interface DoomHeadlessModelSettings {
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
}

export interface DoomHeadlessSession {
  readModelSettings?(): Promise<DoomHeadlessModelSettings>;
  setFastMode?(enabled: boolean): Promise<void>;
  setModelSettings?(settings: Partial<DoomHeadlessModelSettings>): Promise<void>;
  /** Query durable history on demand; hosts do not retain the entire transcript. */
  entries(query?: {
    type?: 'custom' | 'message';
    customType?: string;
    limit?: number;
  }): readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>;
  appendCustomEntry(type: string, data: unknown): Promise<void>;
  /**
   * Delivers operator input through prompt preflight and awaits its turn.
   * Environmental input uses admitPrompt with origin omitted instead.
   * An idle agent is woken; busy delivery uses Durable steering or follow-up.
   */
  prompt(text: string, delivery?: 'prompt' | 'steer' | 'followUp'): Promise<void>;
  /**
   * Admits input without awaiting its turn. Environmental input omits origin and never
   * changes the operator queue. Operator origin uses prompt preflight, including voice
   * capture; 'interrupt' cancels the active run and admits operator input while preserving
   * retained queued work. Environmental callers may reuse requestId when retrying the same input.
   */
  admitPrompt?(
    text: string,
    delivery?: 'prompt' | 'steer' | 'followUp' | 'interrupt',
    origin?: 'operator',
    requestId?: string,
  ): Promise<void>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  activity(): Promise<{ hasPendingMessages: boolean; isIdle: boolean }>;
  /** Renames the durable session and publishes the updated title to presentation clients. */
  setName?(name: string): Promise<void>;
  /** Capture the current persisted branch for an in-process child fork. */
  forkSource?(): Promise<{ kind: 'v4-fork'; sessionFile: string; branch: string; entryId?: string }>;
}

/** A grant-filtered skill view available only during one remote MCP tool invocation. */
export interface DoomMcpSkillAccess {
  list(): Promise<readonly { name: string; description: string }[]>;
  read(name: string): Promise<string>;
}

/** A stateless auxiliary request. These tools are private to this request, never registered on the agent. */
export interface DoomHeadlessToolCompletionRequest {
  systemPrompt: string;
  input: string;
  maxTokens: number;
  cacheRetention?: 'none' | 'short' | 'long';
  signal?: AbortSignal;
  tools: readonly Pick<DoomHeadlessTool, 'name' | 'description' | 'parameters'>[];
}

export interface DoomHeadlessToolCompletionResult {
  toolCalls: readonly { id: string; name: string; arguments: unknown }[];
  usage: { totalTokens: number };
}

export interface DoomHeadlessExecutionContext {
  readonly cwd: string;
  /** The checkout the session runs in, distinct from the tool execution directory. */
  readonly repoRoot: string;
  readonly sessionId: string;
  /** The session's baseline context, when its host knows its workspace. */
  readonly sessionContext?: DoomSessionContext;
  /** Immutable session configuration. Facets must not read or mutate process.env. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly client: DoomHeadlessClient;
  readonly session: DoomHeadlessSession;
  readonly model?: { provider: string; id: string };
  /** Operation cancellation, supplied only for an active invocation. */
  readonly signal?: AbortSignal;
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
  readonly toolCompletion?: {
    complete(reference: string, request: DoomHeadlessToolCompletionRequest): Promise<DoomHeadlessToolCompletionResult>;
  };
  readonly selection: DoomHeadlessSelection;
  /** Present only while an authenticated remote MCP tool is running. */
  readonly mcpSkills?: DoomMcpSkillAccess;
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
  /** Optional capability ceiling. An empty list disables every tool. */
  allowedTools?: readonly string[];
  /**
   * Narrow exclusions without disabling unrelated tools. Exclude a tool your package owns, or a
   * specific foreign tool the mode exists to withdraw. Never enumerate an allowlist here.
   */
  excludedTools?: readonly string[];
}

export interface DoomHeadlessTool<TParameters extends TSchema = TSchema> {
  when?: DoomHeadlessCondition;
  name: string;
  label?: string;
  description: string;
  parameters: TParameters;
  annotations?: Tool['annotations'];
  outputSchema?: Tool['outputSchema'];
  /** Remote presentation only. Component tool access must be explicitly opted into. */
  _meta?: Tool['_meta'] & {
    ui?: {
      resourceUri?: string;
      visibility?: ('model' | 'app')[];
    };
  };
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

/**
 * One package contribution to the session's resource surface.
 *
 * `kind` decides what the model is billed for, and the difference is large:
 * - `context` is EAGER. `read()` runs on every prompt build and the text is pasted
 *   into the system prompt verbatim. Reserve it for small live session state that
 *   exists nowhere on disk. Never use it for a file the package ships: a README
 *   registered this way costs its full length on every single turn.
 * - `skill` is LAZY. Only `name`, `description` and `path` reach the prompt; the
 *   agent reads the file itself when the description matches the task.
 * - `prompt` is inert until the user invokes it by name.
 *
 * The rule in one line: if it is a file the package ships, it is a `skill`.
 */
export interface DoomHeadlessResource {
  when?: DoomHeadlessCondition;
  name: string;
  /** Model-visible selection signal. A `skill` without one tells the agent nothing. */
  description?: string;
  /** Absolute path of the file `read()` returns, so an advertised skill is one the agent can open. */
  path?: string;
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
  ? { lane: string; runId: string; model: { provider: string; id: string; api?: string }; payload: unknown }
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

/** Read-only metadata for the currently applied session, never executable declarations or resource bodies. */
export interface DoomHeadlessCapability {
  readonly source: string;
  readonly name: string;
  readonly kind: 'tool' | 'skill';
  readonly when?: DoomHeadlessCondition;
  readonly active: boolean;
  readonly discoverable: boolean;
  readonly reason?: 'inactive' | 'restricted' | 'shadowed' | 'unavailable' | 'not-discoverable';
}

/** Visibility controls model discovery only, never admission for external execution. */
export function isDoomHeadlessToolModelVisible(tool: Pick<DoomHeadlessTool, '_meta'>): boolean {
  const visibility = tool._meta?.ui?.visibility;
  return visibility === undefined || visibility.includes('model');
}

export interface DoomHeadlessCapabilitySnapshot {
  readonly revision: number;
  readonly ready: boolean;
  readonly capabilities: readonly DoomHeadlessCapability[];
}

/** Registrations inherit package ownership from the caller's Cordis facet. */
/**
 * The tool a server session loads skills through. When a session carries it, the prompt lists
 * every skill by name and points here, so a skill needs no file the agent could read.
 */
export const DOOM_LOAD_SKILL_TOOL = 'load_skill';

export interface DoomHeadlessHostService {
  readonly context: DoomHeadlessExecutionContext;
  /** Admitted external execution, sharing native hooks, restrictions and session lifetime. */
  readonly toolSurface?: Pick<SessionToolSurface, 'readSurface' | 'invokeTool'>;
  /** The instructions of an applied skill by exact name, or undefined when none is applied. */
  readSkill(name: string): string | undefined;
  changeSelection(change: DoomHeadlessSelectionChange): Promise<void>;
  assertActive(source?: string): void;
  subscribeSelection(listener: (selection: DoomHeadlessSelection) => void | Promise<void>): () => void;
  /** Inspect only a coherently applied generation. A transition returns ready=false and no partial inventory. */
  inspectCapabilities(): DoomHeadlessCapabilitySnapshot;
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
