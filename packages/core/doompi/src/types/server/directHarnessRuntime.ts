import type { Context } from '@earendil-works/chord';
import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessResources,
  AgentHarnessTool,
  AgentMessage,
  HarnessEvent,
  AgentLane,
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
  EntryProjector,
  Session,
  ThinkingLevel,
  QueueMode,
} from '@earendil-works/pi-agent-core';
import type { HistoryOwnership } from '../../adapters/serialization/historyImport.ts';

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
  /** Existing v4 JSONL session path. Requires historyOwnership for its lifetime. */
  sessionPath?: string;
  /** Existing v3 JSONL path. It is never opened for writing. */
  legacySessionPath?: string;
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
  /** Awaited preparation for turns/requests. Failures are retained and rejected at model admission. */
  beforeModelRequest?: (boundary: DirectHarnessModelBoundary, context: Context) => void | Promise<void>;
}

export interface DirectHarnessEventListener {
  (event: HarnessEvent, context: Context): void | Promise<void>;
}

/**
 * Same-process AgentProcess compatibility facade backed by a public AgentHarness.
 * `send` and `onFrame` intentionally remain structurally compatible with the
 * legacy server's framed AgentProcess contract.
 */
export interface DirectHarnessRuntime<TContext extends object | undefined = object | undefined> {
  readonly sessionId: string;
  readonly laneName: string;
  readonly harnessId: string;
  readonly session: Session;
  readonly harness: AgentHarness<TContext>;
  readonly lane: AgentLane;
  readonly exited: Promise<number>;
  readonly storageQuarantined: boolean;

  send(frame: DirectHarnessFrame): void;
  onFrame(listener: (frame: DirectHarnessFrame) => void): void;
  onEvent(listener: DirectHarnessEventListener): () => void;
  endInput(): void;
  stop(): void;

  replaceTools(tools: AgentHarnessTool<TContext>[]): Promise<void>;
  replaceResources(resources: AgentHarnessResources): Promise<void>;
  readResources(): Promise<AgentHarnessResources>;
  appendCustomEntry(customType: string, data?: unknown): Promise<string>;
  recordUsage(
    usage: Usage,
    options?: { entryId?: string; details?: import('@earendil-works/pi-agent-core').JsonValue },
  ): Promise<string>;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  followUp(text: string, images?: ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
}
