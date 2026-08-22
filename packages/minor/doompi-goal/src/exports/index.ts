export { registerGoalExtension } from '../adapters/pi/extension';
export { DefaultGoalExtensionService } from '../services/extensionService.ts';
export type { GoalAccountingState, UsageContext, UsageLike } from '../services/accounting.ts';
export {
  assistantUsageTokens,
  checkpointGoalActiveTime,
  cumulativeAssistantTokens,
  currentTokenTotal,
  formatDuration,
  formatTokenCount,
  isNonNegativeFiniteNumber,
  nonNegativeFiniteNumber,
  normalizeTokenBudget,
  updateGoalUsage,
} from '../services/accounting.ts';
export type {
  GoalArgumentCompletion,
  GoalCommandFeatures,
  GoalCommandKind,
  GoalCommandResult,
} from '../services/parser.ts';
export {
  completeGoalArguments,
  MAX_OBJECTIVE_LENGTH,
  parseCommand,
  parseGoalCommand,
  parseTokenBudget,
  validateObjective,
} from '../services/parser.ts';
export type { GoalPromptContext } from '../services/prompts.ts';
export {
  buildContinuePrompt,
  buildGoalPrompt,
  buildGoalSystemPrompt,
  buildObjectiveUpdatedPrompt,
  buildResumePrompt,
} from '../services/prompts.ts';
export type { QueueState } from '../services/queue.ts';
export {
  activateQueuedGoal,
  clearQueue,
  dropLastGoal,
  enqueueGoal,
  prioritizeGoal,
  promoteNextGoal,
  restartGoalFromHistory,
  skipCurrentGoal,
} from '../services/queue.ts';
export type { RuntimeCommitPort } from '../services/runtime.ts';
export { GoalRuntimeModel } from '../services/runtime.ts';
export type { SafetyProgress, SafetySettings } from '../services/safety.ts';
export {
  nextToolFreeRepeatState,
  outputFingerprint,
  resetGoalSafetyEpoch,
  safetyLimitReached,
  shouldPauseForSafety,
} from '../services/safety.ts';
export type { GoalSettings, GoalSettingsLoadResult } from '../services/settings.ts';
export {
  DEFAULT_GOAL_SETTINGS,
  decodeGoalSettings,
  normalizeGoalSettings,
  normalizeToolVisibility,
} from '../services/settings.ts';
export type { SessionEntryLike } from '../services/stateCodec.ts';
export {
  decodeGoalStateEntries,
  GOAL_STATE_ENTRY_TYPE,
  isCanonicalGoalState,
  LEGACY_GOAL_STATE_ENTRY_TYPE,
  loadGoalStateFromSession,
  normalizeLoadedGoal,
  serializeGoalState,
} from '../services/stateCodec.ts';
export type { GoalCreateOptions } from '../services/stateMachine.ts';
export {
  blocksStaleGoalToolCalls,
  createGoal,
  editedGoalStatus,
  formatBudget,
  formatStatus,
  getExecutionState,
  goalIdRejectionReason,
  goalSummary,
  incrementGoal,
  isContradictoryCompletionSummary,
  isGoalToolAllowedForState,
  isResumableGoalStatus,
  isRetainedGoalStatus,
  nextGoalInstance,
  transitionGoal,
} from '../services/stateMachine.ts';
export type { GoalBlockedInput, GoalCompleteInput, GoalToolName, ToolValidationResult } from '../services/tools.ts';
export {
  addGoalTools,
  filterGoalTools,
  GOAL_BLOCKED_TOOL,
  GOAL_COMPLETE_TOOL,
  GOAL_TOOL_NAMES,
  goalToolNamesForState,
  validateBlockedInput,
  validateCompletionInput,
  validateGoalId,
} from '../services/tools.ts';
export type { GoalExtensionDependencies, GoalExtensionResult, GoalExtensionService } from '../types/extension.ts';
export type {
  ActiveGoal,
  GoalExecutionState,
  GoalRuntimeSnapshot,
  GoalStateData,
  GoalStatus,
  LoadedGoalState,
  PendingQueueAction,
  SafetyPauseCause,
} from '../types/goal.ts';
export { GOAL_STATUSES } from '../types/goal.ts';
export type { GoalClock, GoalIdFactory, GoalQueuePort, GoalStateStore } from '../types/ports.ts';
export type { GoalToolVisibility, LegacyGoalToolVisibility } from '../types/settings.ts';
