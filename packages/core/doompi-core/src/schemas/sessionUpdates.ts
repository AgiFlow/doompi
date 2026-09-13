import type { ImageContentPart, JsonValue, TextContentPart } from './sessionProtocol';

/** ACP v2 content and update names used by Doompi's agent presentation. */
export type DoomContentBlock = TextContentPart | ImageContentPart;
export type DoomToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type DoomSessionStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | `_${string}`;

export type DoomSessionUpdate =
  | {
      sessionUpdate: 'user_message' | 'agent_message' | 'agent_thought';
      messageId: string;
      content: DoomContentBlock[];
    }
  | {
      sessionUpdate: 'tool_call_update';
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: DoomToolCallStatus;
      content?: Array<{ type: 'content'; content: DoomContentBlock }>;
      rawInput?: JsonValue;
      rawOutput?: JsonValue;
    }
  | {
      sessionUpdate: 'state_update';
      state: 'running' | 'idle' | 'requires_action';
      stopReason?: DoomSessionStopReason;
    };

/** A bounded Chord replay window. Its sequence is per session and strictly increasing. */
export interface DoomSessionUpdateEvent {
  sequence: number;
  update: DoomSessionUpdate;
}
