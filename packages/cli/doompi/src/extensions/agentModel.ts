import { type AgentModelProjection, DOOM_AGENT_MODEL_ENTRY_TYPE } from '@agimon-ai/doompi-core/agent-model';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Journals the model the agent is on whenever something inside the agent
 * changes it.
 *
 * Pi announces a thinking-level switch on the wire, so a cockpit can follow
 * that field from the frame alone. It announces a model switch only in-process,
 * through `model_select`. Without this entry a client that did not itself ask
 * for the switch keeps whatever model its last `get_state` reported, which is
 * what plan mode applying its configured planning model looks like from a
 * browser: the footer names the model the session left behind.
 *
 * The entry rides Pi's `entry_appended` frames, the same road the minor-mode
 * projection takes, so it reaches live and replaying clients alike.
 */
export function publishAgentModel(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  projection: AgentModelProjection,
  published: string | undefined,
): string {
  const serialized = JSON.stringify(projection);
  // A model_select that resolves to the model already on the record is noise:
  // plan mode restoring the model it never actually changed still fires one.
  if (serialized === published) return serialized;
  pi.appendEntry(DOOM_AGENT_MODEL_ENTRY_TYPE, projection);
  return serialized;
}

export function agentModelExtension(pi: ExtensionAPI): void {
  let published: string | undefined;
  pi.on('model_select', (event) => {
    published = publishAgentModel(pi, { provider: event.model.provider, id: event.model.id }, published);
  });
}

export default agentModelExtension;
