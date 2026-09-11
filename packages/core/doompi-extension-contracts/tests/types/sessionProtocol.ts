import type {
  ClearQueueResult,
  ExtensionUiResponse,
  FollowUpArgs,
  PromptArgs,
  RewindArgs,
  RewindResult,
  SessionCommand,
  SessionService,
  SessionStateInfo,
  SessionStats,
  SteerArgs,
} from '../../src/exports/sessionProtocol.ts';

// Compile-only fixture for the typed control surface. It is included by the
// native typecheck target and never imported at runtime.
declare const service: SessionService;
declare const context: Parameters<SessionService['abort']>[0];
declare const prompt: PromptArgs;
declare const steer: SteerArgs;
declare const followUp: FollowUpArgs;
declare const rewind: RewindArgs;
declare const response: ExtensionUiResponse;

type Assert<T extends true> = T;
type IsAssignable<T, U> = T extends U ? true : false;
type Assertions = [
  Assert<IsAssignable<ClearQueueResult, { steering: string[]; followUp: string[] }>>,
  Assert<IsAssignable<RewindResult, { cancelled: boolean }>>,
  Assert<IsAssignable<SessionStateInfo, { sessionId: string; thinkingLevel: string }>>,
  Assert<IsAssignable<SessionStats, { sessionId: string; totalMessages: number }>>,
  Assert<IsAssignable<SessionCommand, { name: string; source: string }>>,
];
declare const assertions: Assertions;
void assertions;

void service.prompt(prompt, context);
void service.steer(steer, context);
void service.followUp(followUp, context);
void service.rewind(rewind, context);
void service.extensionUiResponse(response, context);
void service.clearQueue(context);
void service.getState(context);
void service.getSessionStats(context);
void service.getCommands(context);
void service.getAvailableModels(context);
void service.getAvailableThinkingLevels(context);
