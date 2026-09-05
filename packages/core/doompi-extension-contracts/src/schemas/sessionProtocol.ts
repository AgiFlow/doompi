import { defineService, type Context, type ReplicatedState } from '@earendil-works/chord';

export const DOOM_SESSION_SERVICE_ID = 'doompi.session.v1';
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

export interface SessionServiceState {
  snapshot: SessionSnapshot;
  progress: TranscriptProgress | null;
}

export interface SessionService {
  readonly state: ReplicatedState<SessionServiceState>;
  prompt(text: string, context: Context): Promise<void>;
  steer(text: string, context: Context): Promise<void>;
  abort(context: Context): Promise<void>;
  setModel(model: ModelRef, context: Context): Promise<void>;
  setThinking(thinkingLevel: ThinkingLevel, context: Context): Promise<void>;
}

export interface SessionManagementService {
  attach(sessionId: string, context: Context): Promise<void>;
  detach(context: Context): Promise<void>;
}

export const DoomSessionService = defineService<SessionService>(DOOM_SESSION_SERVICE_ID);
export const DoomSessionManagementService = defineService<SessionManagementService>(DOOM_SESSION_MANAGEMENT_SERVICE_ID);
