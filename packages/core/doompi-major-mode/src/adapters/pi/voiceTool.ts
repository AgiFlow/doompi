import { requireDoomTransitionCoordinator } from '@agimon-ai/doompi-extension-contracts/transition';
import type { DoomVoiceToolsService } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { VoiceReloadHandoffStore } from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import {
  MAJOR_MODE_VOICE_INPUT_SCHEMA,
  MAJOR_MODE_VOICE_RESULT_SCHEMA,
  MAJOR_MODE_VOICE_TOOL_NAME,
  type MajorModeVoiceInput,
  type MajorModeVoiceResult,
} from '../../schemas/majorModeVoiceTools.ts';
import { MAJOR_MODE_COMMAND, VOICE_SWITCH_TOKEN_PREFIX } from '../../services/majorModeText.ts';
import { MAJOR_MODE_SWITCH_HANDOFF_KIND } from '../../types/majorMode.ts';
import { clearPendingSelection } from '../../services/pendingSelection.ts';
import { MAJOR_MODE_SOURCE, type MajorModeView } from '../../types/majorMode.ts';

type VoiceMessageSender = (
  content: string,
  options: { readonly deliverAs: 'followUp'; readonly expandPromptTemplates: true },
) => void;

function majorModeListing(view: MajorModeView): MajorModeVoiceResult {
  return {
    status: 'listed',
    current: view.majorMode,
    modes: Object.entries(view.config.majorMode).map(([name, definition]) => ({
      name,
      description: definition.description,
      layers: [...definition.layers],
    })),
  };
}

/**
 * The model-facing half of the axis.
 *
 * A switch is never applied here. It plans the transition, mints an opaque
 * handoff token and sends `/mode --voice-switch-token=…` back as a follow-up, so
 * the reload happens inside a command handler where it can be the terminal
 * action.
 */
export function registerMajorModeVoiceCapability(
  voiceTools: DoomVoiceToolsService<ExtensionContext>,
  pi: ExtensionAPI,
  currentView: (ctx: ExtensionContext) => Promise<MajorModeView>,
  reloadHandoffs: VoiceReloadHandoffStore,
  cordisContext: () => Context,
): () => void {
  const registration = voiceTools.register({
    descriptor: {
      source: MAJOR_MODE_SOURCE,
      id: MAJOR_MODE_VOICE_TOOL_NAME,
      name: MAJOR_MODE_VOICE_TOOL_NAME,
      label: 'Major Mode',
      description: 'List configured Doom major modes with their purpose and layers, or queue a validated mode switch.',
      order: 10,
      inputSchema: MAJOR_MODE_VOICE_INPUT_SCHEMA,
      resultSchema: MAJOR_MODE_VOICE_RESULT_SCHEMA,
    },
    async execute(input, execution) {
      const params = input as MajorModeVoiceInput;
      const view = await currentView(execution.context);
      if (params.action === 'list') return majorModeListing(view);

      const majorMode = params.majorMode.trim();
      if (!Object.hasOwn(view.config.majorMode, majorMode)) {
        throw new Error(
          `Unknown major mode: ${majorMode}. Known major modes: ${Object.keys(view.config.majorMode).sort().join(', ')}`,
        );
      }
      if (majorMode === view.majorMode) {
        clearPendingSelection(pi, cordisContext());
        return { status: 'unchanged', majorMode };
      }

      const coordinator = requireDoomTransitionCoordinator(cordisContext());
      const transitionPlan = coordinator.plan({
        sessionId: execution.sessionId,
        hostGeneration: coordinator.hostGeneration,
        operationId: execution.operationId,
        source: 'voice',
        target: { axis: 'major-mode', majorMode },
        signal: execution.signal,
      });
      if (transitionPlan.disposition === 'sync-required') {
        throw new Error(`Major-mode transition requires doompi sync: ${transitionPlan.diagnostics.join(', ')}`);
      }

      const reloadHandoff = reloadHandoffs.prepare(
        {
          active: !execution.signal.aborted,
          sessionId: execution.sessionId,
          hostGeneration: execution.hostGeneration,
        },
        {
          operationId: execution.operationId,
          kind: MAJOR_MODE_SWITCH_HANDOFF_KIND,
          majorMode,
        },
      );
      try {
        const sendUserMessage = pi.sendUserMessage.bind(pi) as unknown as VoiceMessageSender;
        sendUserMessage(`/${MAJOR_MODE_COMMAND} ${VOICE_SWITCH_TOKEN_PREFIX}${reloadHandoff.token}`, {
          deliverAs: 'followUp',
          expandPromptTemplates: true,
        });
      } catch (error) {
        reloadHandoff.discard();
        throw error;
      }
      return { status: 'queued', majorMode, stopBatch: 'session-reload' };
    },
  });
  return () => registration.dispose();
}
