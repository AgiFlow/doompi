import type { JsonValue } from '@earendil-works/chord';
export type { JsonValue } from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord';
import type { Message, ToolResultMessage, ModelThinkingLevel, Tool } from '@earendil-works/pi-ai';
import type {
  Harness,
  Conversation,
  Session,
  Storage,
  CompactionPolicy,
  QueueMode,
  ConversationStreamOptions,
} from '@earendil-works/pi-durable';
import type { Static, TSchema } from 'typebox';

export type AgentMessage = Message | import('@earendil-works/pi-coding-agent').SessionMessageEntry['message'];
export type ThinkingLevel = ModelThinkingLevel;
export type CompactionSettings = Partial<CompactionPolicy>;
export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
}
export interface AgentHarnessResources {
  skills?: Skill[];
  promptTemplates?: { name: string; description?: string; content: string }[];
}
export interface AgentHarnessToolInvocation {
  invocationId: string;
  operationId: string;
  turnId: string;
  getMemo(name: string): Promise<JsonValue | undefined>;
  setMemo(name: string, value: JsonValue | undefined): Promise<void>;
}
export type AgentHarnessTool<
  TContext extends object | undefined = object | undefined,
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
> = Tool<TParameters> & {
  label?: string;
  replay?: 'safe' | 'unsafe';
  executionMode?: 'parallel' | 'sequential';
  prepareArguments?(args: unknown): Static<TParameters>;
  execute(
    callId: string,
    params: Static<TParameters>,
    update: (result: { content: ToolResultMessage['content']; details?: TDetails }) => void,
    toolContext: TContext,
    invocation: AgentHarnessToolInvocation,
    context: Context,
  ): Promise<{ content: ToolResultMessage['content']; details?: TDetails; isError?: boolean }>;
};
export type Entry = { id: string; parentId: string | null; timestamp: number; seq: number } & (
  | { type: 'message'; message: AgentMessage }
  | { type: 'custom'; customType: string; data?: JsonValue }
  | {
      type: 'compaction';
      summary: string;
      tokensBefore: number;
      retainedTail: AgentMessage[];
      fromHook: boolean;
      details?: JsonValue;
      usage?: Usage;
    }
  | {
      type: 'branch_summary';
      summary: string;
      fromId?: string | null;
      fromHook: boolean;
      details?: JsonValue;
      usage?: Usage;
    }
);
export interface SessionStats {
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  usage: Usage;
  sessionId?: string;
  sessionFile?: string;
  totalMessages?: number;
  totalCost?: number;
  contextUsage?: import('@earendil-works/pi-coding-agent').ContextUsage;
}
export interface CompactionPreparation {
  entries: Entry[];
  messages: AgentMessage[];
  tokensBefore: number;
  retainedTail: AgentMessage[];
  firstKeptEntryId?: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  previousSummary?: string;
  fileOps: import('@earendil-works/pi-coding-agent').FileOperations;
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}
export interface CompactResult {
  summary: string;
  tokensBefore: number;
  retainedTail: AgentMessage[];
  details?: JsonValue;
  usage?: Usage;
}
export interface HookMap {
  transform_context: {
    event: { messages: AgentMessage[]; systemPrompt: string };
    result: { messages?: AgentMessage[]; systemPrompt?: string } | undefined;
  };
  before_payload: { event: { model: Model<Api>; payload: unknown }; result: { payload: unknown } | undefined };
  before_tool: {
    event: { toolCallId: string; toolName: string; args: Record<string, JsonValue> };
    result: { args?: Record<string, JsonValue>; block?: { reason: string; terminate?: boolean } } | undefined;
  };
  after_tool: {
    event: {
      toolCallId: string;
      toolName: string;
      args: Record<string, JsonValue>;
      content: ToolResultMessage['content'];
      details?: JsonValue;
      isError: boolean;
      usage?: Usage;
    };
    result:
      | {
          content?: ToolResultMessage['content'];
          details?: JsonValue;
          isError?: boolean;
          usage?: Usage;
          terminate?: boolean;
        }
      | undefined;
  };
  before_compaction: {
    event: {
      reason: 'manual' | 'threshold' | 'overflow';
      preparation: CompactionPreparation;
      customInstructions?: string;
    };
    result: { decline?: boolean; compaction?: CompactResult } | undefined;
  };
}
export type HarnessEvent = (
  | { type: 'run_start' | 'run_resume' | 'turn_start' | 'compaction_start' | 'navigation_start' }
  | { type: 'run_end'; runId?: string; successorActive?: boolean }
  | { type: 'message_start' | 'message_end'; message: AgentMessage; runId?: string; entryId?: string }
  | {
      type: 'message_update';
      message: import('@earendil-works/pi-ai').AssistantMessage;
      event: import('@earendil-works/pi-ai').AssistantMessageEvent;
    }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: Record<string, JsonValue> }
  | {
      type: 'tool_update';
      toolCallId: string;
      toolName: string;
      partialResult: { content: ToolResultMessage['content']; details?: JsonValue };
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      result: { content: ToolResultMessage['content']; details?: JsonValue };
      isError: boolean;
    }
  | { type: 'entry_added'; entry: Entry }
  | { type: 'queue_update'; queues: { kind: string }[] }
  | { type: 'turn_end'; message: import('@earendil-works/pi-ai').AssistantMessage; toolResults: ToolResultMessage[] }
  | {
      type: 'compaction_end';
      status: 'completed' | 'failed' | 'aborted';
      reason: 'manual' | 'threshold' | 'overflow';
      entryId?: string;
      error?: Error;
    }
  | {
      type: 'navigation_end';
      status: 'completed' | 'failed' | 'aborted';
      tipId: string | null;
      fromTipId: string | null;
    }
  | { type: 'value_update'; value: 'session_name'; name: string }
  | {
      type: 'config_update';
      property: 'model';
      value: { provider: string; modelId: string };
      previous?: { provider: string; modelId: string };
    }
  | { type: 'config_update'; property: 'thinkingLevel'; value: ThinkingLevel; previous: ThinkingLevel }
  | { type: 'usage'; row: { id: string; usage: Usage } }
  | { type: 'run_suspend' | 'run_abort' | 'operation_abort' }
  | { type: 'handler_error' | 'error'; error: string }
) & { [key: string]: unknown; lane?: string; runId?: string };
export type EntryProjector = (entry: Entry) => AgentMessage[];
export interface AgentHarnessOptions<TContext extends object | undefined> {
  toolContext?: TContext | ((context: Context) => TContext | Promise<TContext>);
  systemPrompt?: string | ((toolContext: TContext, context: Context) => string | Promise<string>);
  streamOptions?: ConversationStreamOptions;
  toProviderMessages?: (messages: AgentMessage[], context: Context) => Message[] | Promise<Message[]>;
}
import type {
  Api,
  CredentialStore,
  ImageContent,
  Model,
  Models,
  MutableModels,
  Provider,
  RetryPolicy,
  Usage,
} from '@earendil-works/pi-ai';

import type { HistoryOwnership, HistoryOwnershipLease } from '../../services/historyImport';

export interface SqliteSessionStorage {
  storage: Storage;
  session: Session;
  sessionFile: string;
  repository: { close(context: Context): Promise<void> };
  historyLease: HistoryOwnershipLease;
}

/** The opaque frame shape consumed by the existing server compatibility facade. */
export type DirectHarnessFrame = Record<string, unknown>;

export type DirectHarnessModel = Model<Api> | { provider: string; id: string };

export interface DirectHarnessModelBoundary {
  phase: 'turn' | 'request';
  model?: Model<Api>;
  prompt?: AgentMessage[];
  resources: AgentHarnessResources;
}

export interface DirectHarnessRuntimeOptions<TContext extends object | undefined = object | undefined> {
  /** Stable session identity. Existing session files are authoritative when omitted. */
  sessionId?: string;
  /** Working directory used by NodeExecutionEnv and newly-created sessions. */
  cwd: string;
  /** Stable lane identity. Defaults to `main`. */
  lane?: string;
  /** Stable host identity exposed to the parent orchestrator. */
  harnessId?: string;
  sessionName?: string;

  /** Injecting a Session is supported for tests and hosts that already own storage. */
  session?: Session;
  durableStorage?: Storage;
  /** Durable hosts write SQLite. The legacy JSONL selector is rejected. */
  storage?: 'jsonl' | 'sqlite';
  /** Existing durable-v1 SQLite session path. Requires historyOwnership for its lifetime. */
  sessionPath?: string;
  /** Existing v3 JSONL path. It is never opened for writing. */
  legacySessionPath?: string;
  /** Parent identity recorded on newly-created sessions. */
  parentSessionId?: string;
  sessionsRoot?: string;
  /** Required when opening any existing session or importing legacy history. */
  historyOwnership?: HistoryOwnership;
  historyOriginalPath?: string;
  historyStatePath?: string;

  /** Public pi-ai model/provider/credential registries. */
  models?: Models | MutableModels;
  providers?: readonly Provider[];
  credentials?: CredentialStore;
  model?: DirectHarnessModel;

  /** Public AgentHarness tools and resources are explicit, replaceable inputs. */
  tools?: AgentHarnessTool<TContext>[];
  resources?: AgentHarnessResources;
  toolContext?: AgentHarnessOptions<TContext>['toolContext'];
  systemPrompt?: AgentHarnessOptions<TContext>['systemPrompt'];
  streamOptions?: AgentHarnessOptions<TContext>['streamOptions'];
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  thinkingLevel?: ThinkingLevel;
  /** Creation-time inherited intent. Persisted child state wins on reopen; requests remain Codex-only. */
  initialFastMode?: boolean;
  activeToolNames?: string[];
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: 'sequential' | 'parallel';
  toProviderMessages?: AgentHarnessOptions<TContext>['toProviderMessages'];
  entryProjectors?: Record<string, EntryProjector>;
  context?: Context;
  /** Synchronous admission check at the public Models dispatch boundary, before auth/provider work starts. */
  guardModelRequest?: () => void;
  beforeModelRequest?: (boundary: DirectHarnessModelBoundary, context: Context) => void | Promise<void>;
  /** Active AgentHarness execution-hook bridges. */
  transformContext?: (
    event: HookMap['transform_context']['event'],
    context: Context,
  ) => HookMap['transform_context']['result'] | Promise<HookMap['transform_context']['result']>;
  beforePayload?: (
    event: HookMap['before_payload']['event'],
    context: Context,
  ) => HookMap['before_payload']['result'] | Promise<HookMap['before_payload']['result']>;
  beforeTool?: (
    event: HookMap['before_tool']['event'],
    context: Context,
  ) => HookMap['before_tool']['result'] | Promise<HookMap['before_tool']['result']>;
  afterTool?: (
    event: HookMap['after_tool']['event'],
    context: Context,
  ) => HookMap['after_tool']['result'] | Promise<HookMap['after_tool']['result']>;
  beforeCompaction?: (
    event: HookMap['before_compaction']['event'],
    context: Context,
  ) => HookMap['before_compaction']['result'] | Promise<HookMap['before_compaction']['result']>;
  /** Active package commands advertised through the compatibility protocol. */
  listCommands?: () => readonly { name: string; description: string }[];
  /** Returns false when the text is not an active package command, preserving normal prompt handling. */
  dispatchCommand?: (text: string) => Promise<boolean>;
}

export interface DirectHarnessEventListener {
  (event: HarnessEvent, context: Context): void | Promise<void>;
}

export interface DirectHarnessQueuedInput {
  id: string;
  text: string;
  images?: ImageContent[];
  delivery: 'steer' | 'followUp' | 'nextRun';
  scheduling: 'automatic' | 'held';
  disposition: 'pending' | 'handoff' | 'uncertain';
}

export interface DirectHarnessLifecycle {
  revision: number;
  operation: { id: string; kind: 'run' | 'compaction' | 'navigation'; status: 'open' | 'aborting' } | null;
  paused: boolean;
  queue: DirectHarnessQueuedInput[];
}

/** Direct, same-process AgentHarness runtime owned by one session host. */
export interface DirectHarnessRuntime<TContext extends object | undefined = object | undefined> {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly laneName: string;
  readonly harnessId: string;
  readonly session: Session;
  readonly harness: Harness;
  readonly lane: Conversation;
  readonly exited: Promise<number>;
  readonly storageQuarantined: boolean;

  onPresentationFrame(listener: (frame: DirectHarnessFrame) => void): () => void;
  onEvent(listener: DirectHarnessEventListener): () => void;
  stop(): void;

  readState(): Promise<Record<string, unknown>>;
  readLifecycle(): Promise<DirectHarnessLifecycle>;
  enqueueAutomatic(text: string, images?: ImageContent[]): Promise<{ id: string }>;
  removeQueued(id: string): Promise<'removed' | 'in_flight' | 'already_consumed' | 'not_found'>;
  promoteQueued(id: string, operationId?: string): Promise<'promoted' | 'in_flight' | 'target_changed' | 'not_found'>;
  resumeQueue(): Promise<void>;
  /** Reconciles persisted cancellation intent before the host resumes an interrupted native drive. */
  recover(): Promise<void>;
  readEntries(): Promise<{ entries: Entry[]; leafId: string | null }>;
  listCommands(): readonly { name: string; description: string }[];
  /** Dispatches a registered command without admitting a model turn. */
  dispatchCommand(text: string): Promise<boolean>;
  setFastMode(enabled: boolean): Promise<void>;
  setModel(model: { provider: string; id: string }): Promise<void>;
  availableModels(): Promise<readonly Model<Api>[]>;
  /** Shares the harness dispatch guards with host-owned auxiliary model requests. */
  completeModel?: Models['complete'];
  availableThinkingLevels(): Promise<ThinkingLevel[]>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setSteeringMode(mode: QueueMode): Promise<void>;
  setFollowUpMode(mode: QueueMode): Promise<void>;
  navigateTree(
    targetId: string | null,
    options?: Record<string, unknown>,
  ): Promise<{ cancelled: boolean; entries: Entry[] }>;
  clearQueue(): Promise<{ steering: never[]; followUp: never[] }>;
  setName(name: string): Promise<void>;
  getSessionStats(): Promise<SessionStats>;
  replaceTools(tools: AgentHarnessTool<TContext>[]): Promise<void>;
  replaceResources(resources: AgentHarnessResources): Promise<void>;
  readResources(): Promise<AgentHarnessResources>;
  /** Runs one non-agent operation only while the lane is idle, rejecting conflicting starts. */
  runExternalOperation<T>(operation: () => Promise<T>): Promise<T>;
  appendCustomEntry(customType: string, data?: unknown): Promise<string>;
  /**
   * Records a message without waking the agent.
   *
   * The lane defers the write while an operation runs, so a message appended
   * mid-turn lands after the turn's tool results rather than between a tool
   * call and its result, which providers reject on replay.
   */
  appendMessage(message: AgentMessage): Promise<string>;
  /** Names an entry in the session tree. */
  setLabel(targetId: string, label: string | undefined): Promise<void>;
  recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<string>;
  submitPrompt(
    text: string,
    images?: ImageContent[],
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<{ settled: Promise<void>; handledCommand?: boolean }>;
  /** Cancels an active run and directly admits one user message, preserving paused retained inputs. */
  submitUserPrompt(
    text: string | Extract<AgentMessage, { role: 'user' }>,
    images?: ImageContent[],
  ): Promise<{ settled: Promise<void>; handledCommand?: boolean }>;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  /** Starts a run from an already-composed message, without awaiting the run. */
  admitMessage(message: AgentMessage): Promise<{ settled: Promise<void> }>;
  /**
   * Admits host-generated input through Durable, never through the operator queue.
   * `nextTurn` stages without writing or waking the agent and returns resolved settled.
   * Only the next ordinary user prompt admission flushes it, not automatic or internal runs.
   * Reuse requestId to deduplicate retries of steer/followUp admission.
   */
  submitInternalMessage(
    message: string | AgentMessage,
    delivery?: 'steer' | 'followUp' | 'nextTurn',
    requestId?: string,
  ): Promise<{ settled: Promise<void> }>;
  steer(message: string | AgentMessage, images?: ImageContent[], targetOperationId?: string): Promise<void>;
  followUp(message: string | AgentMessage, images?: ImageContent[]): Promise<void>;
  /** Queues for the run after the current one, rather than into it. */
  nextRun(message: string | AgentMessage, images?: ImageContent[]): Promise<void>;
  abort(operationId?: string): Promise<void>;
  /**
   * Cancels the current operation and waits for the lane to go idle. Unlike abort, it does not
   * wait on an external tool invocation, so session teardown can always stop a running turn.
   */
  interrupt(): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  /** Admits a persisted continuation without waiting for its provider/tool work. */
  admitResume(): Promise<{ resumed: boolean; settled: Promise<void> }>;
  /** Continues a persisted in-flight operation; false when the lane had none. */
  resume(): Promise<boolean>;
  dispose(): Promise<void>;
}
