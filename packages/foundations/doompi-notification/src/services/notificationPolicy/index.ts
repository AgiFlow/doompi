const DEFAULT_ASK_USER_BODY = 'The agent is waiting for your feedback.';
const RPC_MODE = 'rpc';

export interface AttentionState {
  agentRunning: boolean;
  askUserBlocked: boolean;
}

export interface ShellSurface {
  hasUI: boolean;
  mode?: string;
}

/**
 * A dialog is worth interrupting the user for only while the agent holds the turn.
 *
 * Outside a run the user opened the dialog themselves and is already looking at
 * it. An ask-user prompt is announced by its own event, so the dialog it then
 * opens must stay silent or the same question notifies twice.
 */
export function warrantsAttentionNotification({ agentRunning, askUserBlocked }: AttentionState): boolean {
  return agentRunning && !askUserBlocked;
}

/** A queued follow-up means the agent keeps working, so the run has not stopped for the user. */
export function warrantsSettledNotification(hasPendingMessages: boolean): boolean {
  return !hasPendingMessages;
}

/** Terminal title escapes only mean something on an attached terminal; RPC output stays clean. */
export function supportsShellTitle({ hasUI, mode }: ShellSurface): boolean {
  return hasUI && mode !== RPC_MODE;
}

/** The question an ask-user prompt is blocking on, or a stand-in when it asked none. */
export function askUserPromptBody(questions: readonly { question: string }[]): string {
  return questions[0]?.question ?? DEFAULT_ASK_USER_BODY;
}
