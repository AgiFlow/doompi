import { type Static, Type } from 'typebox';

/**
 * The custom session entry the runtime journals when the agent's model changes
 * without a client having asked for it.
 *
 * Pi reports a thinking-level switch on the wire as `thinking_level_changed`,
 * so a cockpit can follow that field from the frame alone. It has no matching
 * event for the model: `model_select` is delivered to extensions inside the
 * agent process and never leaves it. A client therefore learns about a model
 * an extension chose (plan mode applying its configured planning model) only
 * by asking for `get_state`, which nothing prompts it to do.
 *
 * This entry closes that gap on the road the minor-mode projection already
 * uses: it rides Pi's `entry_appended` frames, so any RPC client sees the
 * change live and on replay without a new protocol.
 */
export const DOOM_AGENT_MODEL_ENTRY_TYPE = 'doom-agent-model';

export const AgentModelProjectionSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 128 }),
    id: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

/** The model the agent is on, named the way `set_model` and `get_state` name it. */
export type AgentModelProjection = Static<typeof AgentModelProjectionSchema>;
