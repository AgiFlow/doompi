import { defineService, type Context, type ReplicatedState } from '@earendil-works/chord';

import type { DoomSessionUpdateEvent } from './sessionUpdates';

export const DOOM_SESSION_SERVICE_ID = 'doompi.session.v2';
export const DOOM_SESSION_MANAGEMENT_SERVICE_ID = 'doompi.session-management.v1';
export const DOOM_COCKPIT_SERVER_ID = '646f6f6d-7069-4000-8000-000000000001';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SessionPhase = 'idle' | 'turn' | 'compaction' | 'retry';

export interface ModelRef {
  provider: string;
  id: string;
}

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ThinkingContentPart {
  type: 'thinking';
  thinking: string;
  redacted?: true;
}

export interface ToolCallContentPart {
  type: 'toolCall';
  toolCallId: string;
  toolName: string;
  input: JsonValue;
}

export interface UserTranscriptItem {
  id: string;
  role: 'user';
  content: Array<TextContentPart | ImageContentPart>;
  timestamp: number;
}

export interface AssistantTranscriptItem {
  id: string;
  role: 'assistant';
  content: Array<TextContentPart | ThinkingContentPart | ToolCallContentPart>;
  model: ModelRef;
  status: 'streaming' | 'complete' | 'aborted' | 'error';
  stopReason?: 'stop' | 'length' | 'toolUse' | 'aborted' | 'error';
  errorMessage?: string;
  timestamp: number;
}

export interface ToolTranscriptItem {
  id: string;
  role: 'tool';
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  content: Array<TextContentPart | ImageContentPart>;
  details?: JsonValue;
  status: 'running' | 'complete' | 'error';
  isError: boolean;
  timestamp: number;
}

export type TranscriptItem = UserTranscriptItem | AssistantTranscriptItem | ToolTranscriptItem;

export type TranscriptProgress =
  | { type: 'item_started'; item: TranscriptItem }
  | { type: 'item_updated'; item: TranscriptItem }
  | { type: 'item_finished'; item: TranscriptItem };

export interface SessionSnapshot {
  id: string;
  cwd: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  phase: SessionPhase;
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  attached: boolean;
  locked: boolean;
  revision: number;
  transcript: TranscriptItem[];
  queuedSteer: UserTranscriptItem[];
  queuedSteerCount: number;
}

export interface ProtocolEvent {
  sequence: number;
  frame: { type: string; [key: string]: JsonValue };
}

export interface SessionPresentation {
  revision: number;
  dropped: number;
  /** A branch replacement invalidates earlier presentation state, even without ring overflow. */
  resetRevision?: number;
  events: ProtocolEvent[];
  projections: ProtocolEvent[];
}

export interface HubService {
  readonly state: ReplicatedState<{ events: ProtocolEvent[] }>;
  send(frame: { type: string; [key: string]: JsonValue }, context: Context): Promise<void>;
}

export const DoomHubService = defineService<HubService>('doompi.hub.v1');

export interface SessionServiceState {
  snapshot: Omit<SessionSnapshot, 'transcript'>;
  progress: TranscriptProgress | null;
  /** ACP v2-shaped agent events, replayed in sequence across fresh bindings. */
  updates?: DoomSessionUpdateEvent[];
  presentation?: SessionPresentation;
  /** Current concurrent drafts/tools, so a fresh attachment does not depend on missed progress events. */
  inFlight?: TranscriptItem[];
}

export interface TranscriptPageRequest {
  cursor?: string;
  direction?: 'older' | 'newer';
  limit?: number;
  threadId?: string;
}

export interface TranscriptPage {
  entries: JsonValue[];
  startCursor: string | null;
  endCursor: string | null;
  olderCursor: string | null;
  newerCursor: string | null;
  generation: number;
  revision: number;
  /** Profile and other context preceding this page. */
  context: JsonValue[];
  /** Current drafts are separate from committed history. */
  drafts: TranscriptItem[];
}

export interface SessionMessageArgs {
  text: string;
  images?: ImageContentPart[];
}

export interface PromptArgs extends SessionMessageArgs {
  /** Interactive clients acknowledge preflight without owning the supervised turn's lifetime. */
  waitFor?: 'accepted' | 'settled';
}
export type SteerArgs = SessionMessageArgs;
export type FollowUpArgs = SessionMessageArgs;

export interface ClearQueueResult {
  steering: string[];
  followUp: string[];
}

export interface RewindArgs {
  itemId: string;
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface RewindSummaryEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  fromId: string;
  summary: string;
  details?: JsonValue;
  usage?: SessionUsage;
  fromHook?: boolean;
}

export interface RewindResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
  summaryEntry?: RewindSummaryEntry;
}

export type ExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

export interface SessionStateInfo {
  model?: ModelRef;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: 'all' | 'one-at-a-time';
  followUpMode: 'all' | 'one-at-a-time';
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId: string;
  totalMessages: number;
  tokens: SessionUsage;
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface SessionCommandSourceInfo {
  path: string;
  source: string;
  scope: 'user' | 'project' | 'temporary';
  origin: 'package' | 'top-level';
  baseDir?: string;
}

export interface SessionCommand {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
  sourceInfo?: SessionCommandSourceInfo;
}

export interface SessionService {
  readonly state: ReplicatedState<SessionServiceState>;
  readTranscriptPage(args: TranscriptPageRequest, context: Context): Promise<TranscriptPage>;
  prompt(text: string, context: Context): Promise<void>;
  prompt(args: PromptArgs, context: Context): Promise<void>;
  steer(text: string, context: Context): Promise<void>;
  steer(args: SteerArgs, context: Context): Promise<void>;
  abort(context: Context): Promise<void>;
  setModel(model: ModelRef, context: Context): Promise<void>;
  setThinking(thinkingLevel: ThinkingLevel, context: Context): Promise<void>;
  followUp(args: FollowUpArgs, context: Context): Promise<void>;
  clearQueue(context: Context): Promise<ClearQueueResult>;
  rewind(args: RewindArgs, context: Context): Promise<RewindResult>;
  extensionUiResponse(response: ExtensionUiResponse, context: Context): Promise<void>;
  getState(context: Context): Promise<SessionStateInfo>;
  getSessionStats(context: Context): Promise<SessionStats>;
  getCommands(context: Context): Promise<SessionCommand[]>;
  getAvailableModels(context: Context): Promise<ModelRef[]>;
  getAvailableThinkingLevels(context: Context): Promise<ThinkingLevel[]>;
  compact(args: { customInstructions?: string }, context: Context): Promise<JsonValue>;
  setName(name: string, context: Context): Promise<void>;
}

export interface SessionManagementService {
  attach(sessionId: string, context: Context): Promise<void>;
  detach(context: Context): Promise<void>;
}

export const DoomSessionService = defineService<SessionService>(DOOM_SESSION_SERVICE_ID);
export const DoomSessionManagementService = defineService<SessionManagementService>(DOOM_SESSION_MANAGEMENT_SERVICE_ID);
