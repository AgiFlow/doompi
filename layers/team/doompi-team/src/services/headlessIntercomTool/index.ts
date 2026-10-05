import { toDoomHeadlessToolResult, type DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomSessionDeliveryService } from '@agimon-ai/doompi-session';

import { invalidRequest } from '../errors';
import {
  parseTeamToolParams,
  TeamToolParamsSchema,
  validateMessage,
  type NativeTeamRuntime,
} from '../nativeTeamChannel';

export function createHeadlessIntercomTool(
  channel: NativeTeamRuntime,
  sessions?: {
    sessionId: string;
    peers: () => readonly string[];
    delivery: () => DoomSessionDeliveryService | undefined;
  },
): DoomHeadlessTool<typeof TeamToolParamsSchema> {
  return {
    name: 'intercom',
    label: 'Intercom',
    description: 'Communicate with active agents and related live sessions.',
    parameters: TeamToolParamsSchema,
    promptGuidelines: [
      'Send only new progress, blockers, or decisions. Do not repeat task briefs or delegation instructions.',
      'Use members to find related sessions, then send to their session ID to delegate work such as workflow recovery. Session peers use send, not ask/reply.',
    ],
    executionMode: 'serial',
    async execute(toolCallId, parameters, signal, onUpdate) {
      const params = parseTeamToolParams(parameters);
      const peers = channel.current() === undefined ? [] : (sessions?.peers() ?? []);
      const to = params.to?.trim();
      if (sessions !== undefined && to !== undefined && peers.includes(to)) {
        // ponytail: session peers use durable sends; add request correlation only if session ask/reply is needed.
        if (params.action !== 'send')
          throw invalidRequest('Session peers support send only.', 'Use send with the session ID.');
        const message = validateMessage(params.message);
        const delivery = sessions.delivery();
        if (delivery === undefined) throw new Error('Session delivery is unavailable.');
        const receipt = await delivery.deliver({
          deliveryId: `intercom:${sessions.sessionId}:${toolCallId}`,
          recipientKey: to,
          kind: 'intercom_message',
          prompt: `Message from session ${sessions.sessionId} via intercom.\n\n${message}\n\nReply using intercom({ action: "send", to: "${sessions.sessionId}", message: "..." }).`,
          delivery: 'steer',
        });
        return {
          content: [{ type: 'text', text: `Message queued for session ${to}.` }],
          details: { ...receipt, to },
        };
      }
      const result = toDoomHeadlessToolResult(
        await channel.execute(
          toolCallId,
          parameters,
          signal,
          onUpdate && ((partial) => onUpdate(toDoomHeadlessToolResult(partial))),
        ),
      );
      if (params.action !== 'members' || peers.length === 0) return result;
      return {
        ...result,
        content: [
          ...result.content,
          { type: 'text', text: peers.map((id) => `- ${id}: related session (send only)`).join('\n') },
        ],
        details: { members: [...channel.snapshot().members, ...peers.map((id) => ({ name: id, role: 'session' }))] },
      };
    },
  };
}
