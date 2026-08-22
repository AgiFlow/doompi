import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, requireMinorModeCatalog } from '@agimon-ai/doompi-extension-contracts/mode';
import { DOOM_NARRATION_SERVICE, requireDoomNarrationService } from '@agimon-ai/doompi-extension-contracts/narration';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AskUserToolGate } from '../../services/askUserToolGate.js';
import { isAutonomousVoiceActive } from '../../services/autonomousVoiceMode.js';
import { QuestionnaireCoordinator, type QuestionnaireRunner } from '../../services/questionnaireCoordinator.js';
import type { QuestionnaireResult } from '../../types/questionnaire.js';
import { createVoiceQuestionHandoff, type VoiceQuestionHandoff } from '../doom/voiceQuestionHandoff.js';
import { readActiveToolRegistry } from './activeToolRegistry.js';
import { ASK_USER_QUESTION_TOOL_NAME, registerAskUserQuestionTool } from './askUserQuestionAdapter.js';
import { registerAskUserQuestionReconciler } from './reconcileAdapter.js';

const PACKAGE_SOURCE = '@agimon-ai/doompi-user-feedback';
const SESSION_START_EVENT = 'session_start';

function cancelledResult(): QuestionnaireResult {
  return { answers: [], cancelled: true };
}

/** Install one user-feedback runtime into its host-owned Cordis plugin fiber. */
export function installUserFeedbackRuntime(cordis: Context, pi: ExtensionAPI): void {
  let active = true;
  let sessionGeneration = 0;
  let sessionId: string | undefined;
  let sessionReady = false;
  let coordinator = new QuestionnaireCoordinator();
  let voiceHandoff: VoiceQuestionHandoff | undefined;
  const registry = readActiveToolRegistry(pi);
  const toolGate = registry ? new AskUserToolGate(registry, ASK_USER_QUESTION_TOOL_NAME) : undefined;
  let syncToolGate = (): void => undefined;
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
    // Released before the flags drop, so a runtime torn down while Voice is still active
    // cannot leave the tool hidden: Pi re-activates a refreshed tool only when its name is
    // new to the registry, and after a reload this one is not.
    toolGate?.release();
    const ownedCoordinator = coordinator;
    ownedCoordinator.shutdown();
    active = false;
    sessionGeneration += 1;
    sessionReady = false;
    sessionId = undefined;
    await Promise.allSettled(pendingOperations);
    await ownedCoordinator.waitForIdle();
  };
  cordis.effect(() => shutdownRuntime, `${PACKAGE_SOURCE}/runtime`);

  cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE, DOOM_NARRATION_SERVICE], (serviceContext) => {
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
  cordis.inject([DOOM_MINOR_MODE_CATALOG_SERVICE], (modeContext) => {
    if (!toolGate) return undefined;
    const modes = requireMinorModeCatalog(modeContext);
    const apply = (): void => {
      // Pi binds the active-tool accessors to a started session runtime and throws before
      // that, so nothing is applied until the session is ready.
      if (active && sessionReady) toolGate.sync(isAutonomousVoiceActive(modes.list()));
    };
    syncToolGate = apply;
    const unsubscribe = modes.subscribe(apply);
    apply();
    return () => {
      unsubscribe();
      if (syncToolGate === apply) syncToolGate = (): void => undefined;
      toolGate.release();
    };
  });

  registerAskUserQuestionTool(pi, cordis, {
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
      const { runTuiQuestionnaire } = await import('../../tui/runQuestionnaire.js');
      if (!isContextActive(context, signal)) return undefined;
      const result = await runTuiQuestionnaire(context, params, collapseKey, signal, reportProgress);
      return isContextActive(context, signal) ? result : undefined;
    },
    tryVoice: (params) => (active && sessionReady ? voiceHandoff?.handoff(params) : undefined),
  });
  registerAskUserQuestionReconciler(pi, isContextActive);

  pi.on(SESSION_START_EVENT, (_event, context) => {
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
      // A session can start with Voice already active, for example across a Voice reload.
      syncToolGate();
    };

    const operation = lifecycleQueue.then(initializeSession, initializeSession);
    lifecycleQueue = operation.catch(() => undefined);
    return trackOperation(operation);
  });
}

/** The package's sole Pi factory; Pi reloads it and Cordis owns all package resources. */
export async function userFeedbackExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(userFeedbackPlugin, { pi });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

interface UserFeedbackPluginConfig {
  readonly pi: ExtensionAPI;
}

function userFeedbackPlugin(cordis: Context, config: UserFeedbackPluginConfig): void {
  installUserFeedbackRuntime(cordis, config.pi);
}

export default userFeedbackExtension;
