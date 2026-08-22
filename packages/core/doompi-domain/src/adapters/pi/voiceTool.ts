import { requireDoomTransitionCoordinator } from '@agimon-ai/doompi-extension-contracts/transition';
import {
  type DoomVoiceToolsService,
  type VoiceToolRegistrationHandle,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { VoiceReloadHandoffStore } from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { DomainCatalogPort } from '../../commands/domainsCommand.ts';
import {
  EMPTY_DOMAIN_INPUT_SCHEMA,
  LIST_DOMAINS_RESULT_SCHEMA,
  SWITCH_DOMAINS_INPUT_SCHEMA,
  SWITCH_DOMAINS_RESULT_SCHEMA,
  type SwitchDomainsInput,
} from '../../schemas/domainVoiceTools.ts';
import { DOMAIN_COMMAND, VOICE_SWITCH_TOKEN_PREFIX } from '../../services/domainText.ts';
import { DOMAIN_SOURCE } from '../../types/domains.ts';
import type { DomainSwitchHandoff, DomainSwitchHandoffStore } from '../../types/handoff.ts';

const LIST_DOMAINS_ID = 'domains-list';
const SWITCH_DOMAINS_ID = 'domains-switch';

type VoiceMessageSender = (
  content: string,
  options: { readonly deliverAs: 'followUp'; readonly expandPromptTemplates: true },
) => void;

/**
 * The model-facing half of the axis.
 *
 * A switch is never applied here. It plans the transition, parks the validated
 * selection behind an opaque token and sends `/domains --voice-switch-token=…`
 * back as a follow-up, so the reload happens inside a command handler where it
 * can be the terminal action.
 */
export function registerDomainVoiceCapabilities(
  voiceTools: DoomVoiceToolsService<ExtensionContext>,
  pi: ExtensionAPI,
  catalog: DomainCatalogPort,
  store: DomainSwitchHandoffStore,
  reloadHandoffs: VoiceReloadHandoffStore,
  cordisContext: () => Context,
): () => void {
  const registrations: VoiceToolRegistrationHandle[] = [];
  registrations.push(
    voiceTools.register({
      descriptor: {
        source: DOMAIN_SOURCE,
        id: LIST_DOMAINS_ID,
        name: 'list_domains',
        label: 'List domains',
        description: 'List active, effective, and available Doom domains.',
        order: 100,
        inputSchema: EMPTY_DOMAIN_INPUT_SCHEMA,
        resultSchema: LIST_DOMAINS_RESULT_SCHEMA,
      },
      execute: async (_input, execution) => catalog.list(execution.context),
    }),
  );
  registrations.push(
    voiceTools.register({
      descriptor: {
        source: DOMAIN_SOURCE,
        id: SWITCH_DOMAINS_ID,
        name: 'switch_domains',
        label: 'Switch domains',
        description: 'Queue a validated Doom domain selection and reload the session.',
        order: 110,
        inputSchema: SWITCH_DOMAINS_INPUT_SCHEMA,
        resultSchema: SWITCH_DOMAINS_RESULT_SCHEMA,
      },
      execute: async (input, execution) => {
        const request = input as SwitchDomainsInput;
        const domains = await catalog.validate(execution.context, request.domains);
        const coordinator = requireDoomTransitionCoordinator(cordisContext());
        coordinator.plan({
          sessionId: execution.sessionId,
          hostGeneration: coordinator.hostGeneration,
          operationId: execution.operationId,
          source: 'voice',
          target: { axis: 'domains', domains },
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
            domains,
          },
        );
        let queued: DomainSwitchHandoff | undefined;
        try {
          queued = store.issue({
            sessionId: execution.sessionId,
            hostGeneration: execution.hostGeneration,
            operationId: execution.operationId,
            domains,
            reloadHandoffToken: reloadHandoff.token,
          });
          // The selection travels in the store, never in the follow-up text, so a
          // transcript cannot be edited into a different switch.
          const sendUserMessage = pi.sendUserMessage.bind(pi) as unknown as VoiceMessageSender;
          sendUserMessage(`/${DOMAIN_COMMAND} ${VOICE_SWITCH_TOKEN_PREFIX}${queued.token}`, {
            deliverAs: 'followUp',
            expandPromptTemplates: true,
          });
        } catch (error) {
          if (queued) store.discard(queued.token, execution);
          reloadHandoff.discard();
          throw error;
        }
        return { status: 'queued', stopBatch: 'session-reload' };
      },
    }),
  );
  return () => {
    for (const registration of registrations.reverse()) registration.dispose();
  };
}
