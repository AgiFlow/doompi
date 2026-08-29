import { VoiceToolDescribeInputSchema } from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { sessionVoiceOwnership } from '../../services/sessionVoiceOwnership.ts';

export const TRANSFER_VOICE_TOOL_NAME = 'transfer_voice';
const TransferVoiceInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: { target: { type: 'integer', minimum: 1, maximum: 10_000 } },
} as unknown as typeof VoiceToolDescribeInputSchema;

function result(text: string, accepted: boolean): AgentToolResult<{ accepted: boolean }> {
  return { content: [{ type: 'text', text }], details: { accepted } };
}

function description(): string {
  const targets = sessionVoiceOwnership.snapshot().targets;
  const catalog = targets.map((target) => `${target.order}. ${target.label}`).join('\n');
  return `Hand autonomous voice to one eligible session by its current number. Session IDs remain private.\n\nEligible sessions:\n${catalog || '(none)'}`;
}

function definition(): ToolDefinition<typeof TransferVoiceInputSchema, { accepted: boolean }> {
  return {
    name: TRANSFER_VOICE_TOOL_NAME,
    label: 'Hand off voice',
    description: description(),
    promptSnippet: 'Hand autonomous voice to an eligible session.',
    promptGuidelines: [
      'Use the numbered target currently listed in this tool description.',
      'The server turns off this session before it activates the target session.',
    ],
    parameters: TransferVoiceInputSchema,
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, _context: ExtensionContext) {
      const target = (params as unknown as { target?: unknown }).target;
      if (!Number.isSafeInteger(target) || (target as number) < 1)
        return result('Voice handoff rejected: target session number is invalid.', false);
      const catalogTarget = sessionVoiceOwnership.snapshot().targets.find((candidate) => candidate.order === target);
      if (catalogTarget === undefined || sessionVoiceOwnership.handoff(target as number) === undefined)
        return result('Voice handoff rejected: the target is unavailable or no longer eligible.', false);
      return result(
        `Voice handoff to "${catalogTarget.label}" requested. The current agent continues working while the server switches autonomous voice.`,
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
  const snapshot = sessionVoiceOwnership.snapshot();
  const visible = snapshot.registration?.active === true && snapshot.targets.length > 0;
  const current = pi.getActiveTools();
  const active = current.filter((name) => name !== TRANSFER_VOICE_TOOL_NAME);
  if (visible) active.push(TRANSFER_VOICE_TOOL_NAME);
  if (active.length !== current.length || active.some((name, index) => name !== current[index]))
    pi.setActiveTools(active);
}
