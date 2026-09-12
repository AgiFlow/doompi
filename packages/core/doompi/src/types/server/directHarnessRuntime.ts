import type { Context } from '@earendil-works/chord';
import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessResources,
  AgentHarnessTool,
  AgentMessage,
  HarnessEvent,
  AgentLane,
  HookMap,
} from '@earendil-works/pi-agent-core';
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
import type {
  CompactionSettings,
  Entry,
  EntryProjector,
  Session,
  SessionStats,
  ThinkingLevel,
  QueueMode,
} from '@earendil-works/pi-agent-core';
import type { HistoryOwnership, HistoryOwnershipLease } from '../../adapters/serialization/historyImport.ts';

export interface SqliteSessionStorage {
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
  /** Server hosts select SQLite; terminal hosts retain JSONL. */
  storage?: 'jsonl' | 'sqlite';
  /** Existing v4 JSONL session path. Requires historyOwnership for its lifetime. */
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

/** Direct, same-process AgentHarness runtime owned by one session host. */
export interface DirectHarnessRuntime<TContext extends object | undefined = object | undefined> {
  readonly sessionId: string;
  readonly laneName: string;
  readonly harnessId: string;
  readonly session: Session;
  readonly harness: AgentHarness<TContext>;
  readonly lane: AgentLane;
  readonly exited: Promise<number>;
  readonly storageQuarantined: boolean;

  onPresentationFrame(listener: (frame: DirectHarnessFrame) => void): () => void;
  onEvent(listener: DirectHarnessEventListener): () => void;
  stop(): void;

  readState(): Promise<Record<string, unknown>>;
  readEntries(): Promise<{ entries: Entry[]; leafId: string | null }>;
  listCommands(): readonly { name: string; description: string }[];
  setModel(model: { provider: string; id: string }): Promise<void>;
  availableModels(): Promise<readonly Model<Api>[]>;
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
  appendCustomEntry(customType: string, data?: unknown): Promise<string>;
  recordUsage(
    usage: Usage,
    options?: { entryId?: string; details?: import('@earendil-works/pi-agent-core').JsonValue },
  ): Promise<string>;
  submitPrompt(text: string, images?: ImageContent[]): Promise<{ settled: Promise<void>; handledCommand?: boolean }>;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  followUp(text: string, images?: ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
}
