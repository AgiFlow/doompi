import { definePiTool, type PiToolCollection } from '@agimon-ai/doompi-core/pi-extension';
import type { DoomToolRestriction } from '@agimon-ai/doompi-core/tool-surface';
import type { AgentToolResult, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';

import { VoiceToolDescribeInputSchema } from '../schemas/voiceTools';
import { sessionVoiceOwnership } from '../services/sessionVoiceOwnership';

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

export interface TransferVoiceToolLifecycle extends PiToolCollection {
  sessionStarted(): void;
  dispose(): void;
}

export function createTransferVoiceToolLifecycle(
  applyRestriction: (restrict: DoomToolRestriction) => void,
): TransferVoiceToolLifecycle {
  let nativeTool = definition();
  let tool = definePiTool(nativeTool);
  let digest = nativeTool.description;
  let disposed = false;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const reconcile = (): void => {
    if (disposed) return;
    const next = description();
    if (next !== digest) {
      digest = next;
      nativeTool = definition();
      tool = definePiTool(nativeTool);
      listeners.forEach((listener) => listener());
    }
    applyRestriction(transferVoiceToolRestriction(transferVoiceToolVisible()));
  };
  return {
    snapshot: () => (disposed ? [] : [tool]),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sessionStarted() {
      if (disposed) return;
      if (timer) clearInterval(timer);
      reconcile();
      timer = setInterval(reconcile, 1_000);
      timer.unref?.();
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      listeners.clear();
    },
  };
}

/** The tool means something only while this session holds voice and the server lists a target. */
export function transferVoiceToolVisible(): boolean {
  const snapshot = sessionVoiceOwnership.snapshot();
  return snapshot.registration?.active === true && snapshot.targets.length > 0;
}

/**
 * Hides the handoff tool until a handoff is actually possible.
 *
 * The tool stays registered for the whole session; the surface recomputes from
 * the registered set, so becoming visible again needs no bookkeeping here.
 */
export function transferVoiceToolRestriction(visible: boolean): DoomToolRestriction {
  return (incoming) => (visible ? incoming : incoming.filter((name) => name !== TRANSFER_VOICE_TOOL_NAME));
}
