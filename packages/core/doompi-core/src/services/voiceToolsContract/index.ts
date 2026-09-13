import type { Context } from '@deepseek-ai/cordis';
import type { TSchema } from 'typebox';

import { DOOM_VOICE_TOOLS_SERVICE } from '../../constants/voiceTools';
import type {
  VoiceToolBatchResult,
  VoiceToolCatalogSnapshot,
  VoiceToolDescribeInput,
  VoiceToolErrorCode,
  VoiceToolUseInput,
} from '../../schemas/voiceTools';

export interface VoiceToolDescriptor {
  readonly source: string;
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly order: number;
  readonly inputSchema: TSchema;
  readonly resultSchema: TSchema;
  readonly timeoutMs?: number;
}

export interface VoiceToolExecutionContext<Context = unknown> {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly operationId: string;
  readonly batchIndex: number;
  readonly batchSize: number;
  readonly signal: AbortSignal;
  readonly context: Context;
}

export interface VoiceToolDefinition<Context = unknown> {
  readonly descriptor: VoiceToolDescriptor;
  execute(input: unknown, execution: VoiceToolExecutionContext<Context>): unknown;
}

export interface VoiceToolRegistrationHandle {
  readonly source: string;
  readonly id: string;
  readonly registrationGeneration: string;
  dispose(): void;
}

export interface VoiceToolSessionHandle<Context = unknown> {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly active: boolean;
  setActive(active: boolean): void;
  subscribe(listener: () => void): () => void;
  describe(input?: VoiceToolDescribeInput): VoiceToolCatalogSnapshot;
  executeBatch(
    input: VoiceToolUseInput,
    context: Context,
    options?: VoiceToolExecuteOptions,
  ): Promise<VoiceToolBatchResult>;
  useVoiceTools(
    input: VoiceToolUseInput,
    context: Context,
    options?: VoiceToolExecuteOptions,
  ): Promise<VoiceToolBatchResult>;
  dispose(): void;
}

export interface VoiceToolExecuteOptions {
  readonly signal?: AbortSignal;
  readonly operationId?: string;
}

export interface VoiceToolRegistrationOptions<Context = unknown> {
  readonly sessionId?: string;
  readonly context?: Context;
}

/** Shared Cordis contract implemented by an optional voice-tool provider. */
export interface DoomVoiceToolsService<SessionContext = unknown> {
  readonly generation: string;
  register<ContributionContext = SessionContext>(
    definition: VoiceToolDefinition<ContributionContext>,
    options?: VoiceToolRegistrationOptions<ContributionContext>,
  ): VoiceToolRegistrationHandle;
  bindSession(sessionId: string, context?: SessionContext): VoiceToolSessionHandle<SessionContext>;
  readSession(sessionId: string): VoiceToolSessionHandle<SessionContext> | undefined;
  subscribeSession(
    sessionId: string,
    listener: (session: VoiceToolSessionHandle<SessionContext> | undefined) => void,
  ): () => void;
  dispose(): void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/voice-tools': DoomVoiceToolsService;
  }
}

export class VoiceToolError extends Error {
  readonly code: VoiceToolErrorCode;
  readonly retryable: boolean;

  constructor(code: VoiceToolErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'VoiceToolError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function readDoomVoiceToolsService(context: Context): DoomVoiceToolsService | undefined {
  return context.get(DOOM_VOICE_TOOLS_SERVICE) as DoomVoiceToolsService | undefined;
}

export function requireDoomVoiceToolsService(context: Context): DoomVoiceToolsService {
  const service = readDoomVoiceToolsService(context);
  if (!service) throw new Error('Doom voice tools are unavailable. Load @agimon-ai/doompi-voice.');
  return service;
}
