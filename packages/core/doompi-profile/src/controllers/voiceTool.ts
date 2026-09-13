import type { AgentProfile } from '@agimon-ai/doompi-config/profiles';
import { requireDoomTransitionCoordinator } from '@agimon-ai/doompi-core/transition';
import type { VoiceReloadHandoffStore } from '@agimon-ai/doompi-core/voice-reload-handoff';
import type { DoomVoiceToolsService } from '@agimon-ai/doompi-core/voice-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  PROFILE_VOICE_INPUT_SCHEMA,
  PROFILE_VOICE_RESULT_SCHEMA,
  PROFILE_VOICE_TOOL_NAME,
  type ProfileVoiceInput,
  type ProfileVoiceResult,
} from '../schemas/profileVoiceTools';
import {
  PROFILE_COMMAND,
  PROFILE_SOURCE,
  PROFILE_SWITCH_HANDOFF_KIND,
  profileDescription,
  VOICE_SWITCH_TOKEN_PREFIX,
} from '../services/profileText';

type VoiceMessageSender = (
  content: string,
  options: { readonly deliverAs: 'followUp'; readonly expandPromptTemplates: true },
) => void;

/** What the capability needs from the session, kept narrow so tests need no harness. */
export interface ProfileVoiceView {
  readonly current?: string;
  readonly profiles: readonly AgentProfile[];
}

function profileListing(view: ProfileVoiceView): ProfileVoiceResult {
  return {
    status: 'listed',
    ...(view.current === undefined ? {} : { current: view.current }),
    profiles: view.profiles.map((profile) => ({
      name: profile.name,
      description: profileDescription(profile),
      ...(profile.identity?.name === undefined ? {} : { displayName: profile.identity.name }),
    })),
  };
}

/**
 * The model-facing half of the axis.
 *
 * A switch is never applied here. It plans the transition, mints an opaque
 * handoff token and sends `/profile --voice-switch-token=…` back as a follow-up,
 * so the reload happens inside a command handler where it can be the terminal
 * action. The profile name stays out of the message text on purpose: an edited
 * transcript must not be able to redirect the switch.
 */
export function registerProfileVoiceCapability(
  voiceTools: DoomVoiceToolsService<ExtensionContext>,
  pi: ExtensionAPI,
  currentView: (ctx: ExtensionContext) => Promise<ProfileVoiceView>,
  reloadHandoffs: VoiceReloadHandoffStore,
  cordisContext: () => Context,
): () => void {
  const registration = voiceTools.register({
    descriptor: {
      source: PROFILE_SOURCE,
      id: PROFILE_VOICE_TOOL_NAME,
      name: PROFILE_VOICE_TOOL_NAME,
      label: 'Profile',
      description:
        'List the personas configured for this session with their display names, or queue a switch to one of them.',
      order: 20,
      inputSchema: PROFILE_VOICE_INPUT_SCHEMA,
      resultSchema: PROFILE_VOICE_RESULT_SCHEMA,
    },
    async execute(input, execution) {
      const params = input as ProfileVoiceInput;
      const view = await currentView(execution.context);
      if (params.action === 'list') return profileListing(view);

      const profile = view.profiles.find((candidate) => candidate.name === params.profile);
      if (!profile) {
        throw new Error(`Unknown profile: ${params.profile}`);
      }
      if (profile.name === view.current) return { status: 'unchanged', profile: profile.name };

      const coordinator = requireDoomTransitionCoordinator(cordisContext());
      coordinator.plan({
        sessionId: execution.sessionId,
        hostGeneration: coordinator.hostGeneration,
        operationId: execution.operationId,
        source: 'voice',
        target: { axis: 'profile', profile: profile.name },
        signal: execution.signal,
      });

      const reloadHandoff = reloadHandoffs.prepare(
        {
          active: !execution.signal.aborted,
          sessionId: execution.sessionId,
          hostGeneration: execution.hostGeneration,
        },
        {
          operationId: execution.operationId,
          kind: PROFILE_SWITCH_HANDOFF_KIND,
          profile: profile.name,
        },
      );
      try {
        const sendUserMessage = pi.sendUserMessage.bind(pi) as unknown as VoiceMessageSender;
        sendUserMessage(`/${PROFILE_COMMAND} ${VOICE_SWITCH_TOKEN_PREFIX}${reloadHandoff.token}`, {
          deliverAs: 'followUp',
          expandPromptTemplates: true,
        });
      } catch (error) {
        reloadHandoff.discard();
        throw error;
      }
      return { status: 'queued', profile: profile.name, stopBatch: 'session-reload' };
    },
  });
  return () => registration.dispose();
}
