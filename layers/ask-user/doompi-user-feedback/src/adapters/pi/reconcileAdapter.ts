import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ASK_USER_QUESTION_TOOL_NAME } from './askUserQuestionAdapter.js';

export function reconcileAskUserQuestionTool(pi: ExtensionAPI, context: Pick<ExtensionContext, 'hasUI'>): void {
  const activeTools = pi.getActiveTools();
  const active = activeTools.includes(ASK_USER_QUESTION_TOOL_NAME);
  if (!context.hasUI && active) {
    pi.setActiveTools(activeTools.filter((name) => name !== ASK_USER_QUESTION_TOOL_NAME));
    return;
  }
  if (context.hasUI && !active) {
    pi.setActiveTools([...activeTools, ASK_USER_QUESTION_TOOL_NAME]);
  }
}

export function registerAskUserQuestionReconciler(
  pi: ExtensionAPI,
  isActive: (context: ExtensionContext) => boolean = () => true,
): void {
  pi.on('before_agent_start', (_event, context) => {
    if (isActive(context)) reconcileAskUserQuestionTool(pi, context);
  });
}
