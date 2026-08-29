import { VoiceToolDescribeInputSchema } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { sessionVoiceOwnership } from '../../services/sessionVoiceOwnership.ts';

export const TRANSFER_VOICE_TOOL_NAME = 'transfer_voice';
const TransferVoiceInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: { target: { type: 'string', minLength: 1, maxLength: 128 } },
} as unknown as typeof VoiceToolDescribeInputSchema;

function result(text: string, accepted: boolean): AgentToolResult<{ accepted: boolean }> {
  return { content: [{ type: 'text', text }], details: { accepted } };
}

function description(): string {
  const targets = sessionVoiceOwnership.snapshot().view.targets;
  const catalog = targets.map((target) => `- ${target.label}: ${target.handle}`).join('\n');
  return `Transfer autonomous voice ownership to one eligible target. Target handles are opaque and source-bound.\n\nEligible targets:\n${catalog}`;
}

function definition(): ToolDefinition<typeof TransferVoiceInputSchema, { accepted: boolean }> {
  return {
    name: TRANSFER_VOICE_TOOL_NAME,
    label: 'Transfer voice',
    description: description(),
    promptSnippet: 'Transfer voice ownership to an eligible session.',
    promptGuidelines: [
      'Use only a target handle currently listed in this tool description. Handles are opaque and may become stale.',
      'A transfer is transactional. A rejected request performs no partial ownership change.',
    ],
    parameters: TransferVoiceInputSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, _context: ExtensionContext) {
      const target = (params as unknown as { target?: unknown }).target;
      if (typeof target !== 'string') return result('Voice transfer rejected: target handle is invalid.', false);
      const accepted = sessionVoiceOwnership.transfer(target);
      return accepted === undefined
        ? result('Voice transfer rejected: ownership or target eligibility changed.', false)
        : result(
            'Voice transfer requested. The current agent continues working while voice control moves transactionally.',
            true,
          );
    },
  };
}

export interface TransferVoiceToolRegistration {
  refresh(): void;
}

export interface TransferVoiceToolLifecycle {
  sessionStarted(): void;
  dispose(): void;
}

export function registerTransferVoiceTool(pi: Pick<ExtensionAPI, 'registerTool'>): TransferVoiceToolRegistration {
  let digest = description();
  pi.registerTool(definition());
  return {
    refresh() {
      const next = description();
      if (next === digest) return;
      digest = next;
      pi.registerTool(definition());
    },
  };
}

export function createTransferVoiceToolLifecycle(
  pi: Pick<ExtensionAPI, 'registerTool' | 'getActiveTools' | 'setActiveTools'>,
): TransferVoiceToolLifecycle {
  const registration = registerTransferVoiceTool(pi);
  let timer: ReturnType<typeof setInterval> | undefined;
  const reconcile = (): void => {
    registration.refresh();
    reconcileTransferVoiceTool(pi);
  };
  return {
    sessionStarted() {
      if (timer) clearInterval(timer);
      reconcile();
      timer = setInterval(reconcile, 1_000);
      timer.unref?.();
    },
    dispose() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export function reconcileTransferVoiceTool(pi: Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>): void {
  const view = sessionVoiceOwnership.snapshot().view;
  const visible = view.owner && !view.transaction && view.targets.length > 0;
  const current = pi.getActiveTools();
  const active = current.filter((name) => name !== TRANSFER_VOICE_TOOL_NAME);
  if (visible) active.push(TRANSFER_VOICE_TOOL_NAME);
  if (active.length !== current.length || active.some((name, index) => name !== current[index]))
    pi.setActiveTools(active);
}
