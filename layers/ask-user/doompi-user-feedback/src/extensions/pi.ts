import { definePiExtension, definePiTool } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, requireMinorModeCatalog } from '@agimon-ai/doompi-extension-contracts/mode';
import { DOOM_NARRATION_SERVICE, requireDoomNarrationService } from '@agimon-ai/doompi-extension-contracts/narration';
import { type DoomToolRestriction } from '@agimon-ai/doompi-extension-contracts/tool-surface';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { askUserToolRestriction } from '../services/askUserToolGate';
import { isAutonomousVoiceActive } from '../services/autonomousVoiceMode';
import { QuestionnaireCoordinator, type QuestionnaireRunner } from '../services/questionnaireCoordinator';
import type { QuestionnaireResult } from '../types/questionnaire';
import { createVoiceQuestionHandoff, type VoiceQuestionHandoff } from '../services/voiceQuestionHandoff';
import { createAskUserQuestionTool } from '../tools/askUserQuestion';
import { ASK_USER_QUESTION_TOOL_NAME } from '../constants/tool';
import { askUserToolRender } from '../tui/askUserToolRender';
import type { Context } from '@deepseek-ai/cordis';

import { PACKAGE_SOURCE } from '../constants/package';

function cancelledResult(): QuestionnaireResult {
  return { answers: [], cancelled: true };
}

export const userFeedbackExtension = definePiExtension(PACKAGE_SOURCE, ({ context: cordis }) => {
  let active = true;
  let sessionGeneration = 0;
  let sessionId: string | undefined;
  let sessionReady = false;
  let coordinator = new QuestionnaireCoordinator();
  let voiceHandoff: VoiceQuestionHandoff | undefined;
  let voiceActive = false;
  let hasUI = true;
  const restrictionListeners = new Set<() => void>();
  const currentRestriction = (): DoomToolRestriction =>
    askUserToolRestriction(ASK_USER_QUESTION_TOOL_NAME, hasUI && !voiceActive);
  const syncToolRestriction = (): void => restrictionListeners.forEach((listener) => listener());
  let lifecycleQueue: Promise<void> = Promise.resolve();
  const pendingOperations = new Set<Promise<unknown>>();

  const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
    pendingOperations.add(operation);
    void operation.then(
      () => pendingOperations.delete(operation),
      () => pendingOperations.delete(operation),
    );
    return operation;
  };
  const ownsGeneration = (generation: number, expectedSessionId: string | undefined): boolean =>
    active && generation === sessionGeneration && expectedSessionId === sessionId;
  const isContextActive = (context: ExtensionContext, signal?: AbortSignal): boolean =>
    active && sessionReady && signal?.aborted !== true && context.sessionManager.getSessionId() === sessionId;

  const shutdownRuntime = async (): Promise<void> => {
    if (!active) return;
    const ownedCoordinator = coordinator;
    ownedCoordinator.shutdown();
    active = false;
    sessionGeneration += 1;
    sessionReady = false;
    sessionId = undefined;
    await Promise.allSettled(pendingOperations);
    await ownedCoordinator.waitForIdle();
  };

  const toolDependencies: Parameters<typeof createAskUserQuestionTool>[1] = {
    enqueue: (runner: QuestionnaireRunner, signal?: AbortSignal) => {
      const ownedCoordinator = coordinator;
      const generation = sessionGeneration;
      const expectedSessionId = sessionId;
      if (!sessionReady || !ownsGeneration(generation, expectedSessionId) || signal?.aborted) {
        return Promise.resolve(cancelledResult());
      }
      return ownedCoordinator.enqueue(async (context) => {
        if (!sessionReady || !ownsGeneration(generation, expectedSessionId) || context.signal.aborted) {
          return cancelledResult();
        }
        const result = await runner({
          ...context,
          reportProgress: (progress) => {
            if (ownsGeneration(generation, expectedSessionId) && !context.signal.aborted) {
              context.reportProgress(progress);
            }
          },
        });
        return sessionReady && ownsGeneration(generation, expectedSessionId) && !context.signal.aborted
          ? result
          : cancelledResult();
      }, signal);
    },
    isActive: isContextActive,
    runTui: async (context, params, collapseKey, signal, reportProgress) => {
      if (!isContextActive(context, signal)) return undefined;
      const { runTuiQuestionnaire } = await import('../tui/runQuestionnaire');
      if (!isContextActive(context, signal)) return undefined;
      const result = await runTuiQuestionnaire(context, params, collapseKey, signal, reportProgress);
      return isContextActive(context, signal) ? result : undefined;
    },
    tryVoice: (params) => (active && sessionReady ? voiceHandoff?.handoff(params) : undefined),
  };

  const beforeAgentStart = (_event: unknown, context: ExtensionContext) => {
    if (!isContextActive(context)) return;
    hasUI = context.hasUI;
    syncToolRestriction();
  };

  const sessionStart = (_event: unknown, context: ExtensionContext) => {
    if (!active) return;
    const previousCoordinator = coordinator;
    previousCoordinator.shutdown();
    const activeSessionId = context.sessionManager.getSessionId();
    const generation = ++sessionGeneration;
    const nextCoordinator = new QuestionnaireCoordinator();
    coordinator = nextCoordinator;
    sessionId = activeSessionId;
    sessionReady = false;

    const initializeSession = async (): Promise<void> => {
      await previousCoordinator.waitForIdle();
      if (!ownsGeneration(generation, activeSessionId)) return;
      sessionReady = true;
      // The surface is re-registered per session from the gate state in force, so a session
      // that starts with Voice already active needs nothing extra here.
    };

    const operation = lifecycleQueue.then(initializeSession, initializeSession);
    lifecycleQueue = operation.catch(() => undefined);
    return trackOperation(operation);
  };
  return {
    services: [
      (serviceContextOwner: Context) => {
        serviceContextOwner.inject([DOOM_MINOR_MODE_CATALOG_SERVICE, DOOM_NARRATION_SERVICE], (serviceContext) => {
          const handoff = createVoiceQuestionHandoff(
            requireMinorModeCatalog(serviceContext),
            requireDoomNarrationService(serviceContext),
          );
          voiceHandoff = handoff;
          return () => {
            if (voiceHandoff === handoff) voiceHandoff = undefined;
          };
        });

        // Separate from the handoff binding above: the gate needs only the mode catalog, so it
        // still applies to a Voice build that publishes modes without providing narration.
        serviceContextOwner.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
          const modes = requireMinorModeCatalog(modeContext);
          const apply = (): void => {
            voiceActive = isAutonomousVoiceActive(modes.list());
            syncToolRestriction();
          };
          const unsubscribe = modes.subscribe(apply);
          apply();
          return () => {
            unsubscribe();
            voiceActive = false;
            syncToolRestriction();
          };
        });
      },
    ],
    tools: [definePiTool(createAskUserQuestionTool(cordis, toolDependencies, askUserToolRender))],
    events: { before_agent_start: beforeAgentStart, session_start: sessionStart },
    onDispose: shutdownRuntime,
    toolRestrictions: [
      {
        source: PACKAGE_SOURCE,
        get restrict() {
          return currentRestriction();
        },
        subscribe(listener) {
          restrictionListeners.add(listener);
          return () => {
            restrictionListeners.delete(listener);
          };
        },
      },
    ],
  };
});
export default userFeedbackExtension;
