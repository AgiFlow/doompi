import { InlineAgentSchema, type InlineAgent } from '@agimon-ai/doompi-core/delegation';
import { type Static, Type } from 'typebox';

export { InlineAgentSchema };
export type { InlineAgent };

export const SUBAGENT_ACTIONS = {
  agents: 'agents',
  run: 'run',
  status: 'status',
  steer: 'steer',
  stop: 'stop',
  suspended: 'suspended',
  restore: 'restore',
} as const;

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[keyof typeof SUBAGENT_ACTIONS];

export const SUBAGENT_ACTION_FIELDS = {
  agents: ['action', 'name', 'cwd', 'scope'],
  run: ['action', 'requests', 'concurrency', 'artifacts', 'scope'],
  status: ['action', 'id', 'transcriptLines'],
  steer: ['action', 'id', 'message'],
  stop: ['action', 'id', 'reason'],
  suspended: ['action'],
  restore: ['action', 'id'],
} as const satisfies Record<SubagentAction, readonly string[]>;

const IMPLEMENTED_ACTIONS: ReadonlySet<string> = new Set(Object.values(SUBAGENT_ACTIONS));

export function isSubagentAction(value: unknown): value is SubagentAction {
  return typeof value === 'string' && IMPLEMENTED_ACTIONS.has(value);
}

export function subagentActionAcceptsField(action: SubagentAction, field: string): boolean {
  return (SUBAGENT_ACTION_FIELDS[action] as readonly string[]).includes(field);
}

/** Remove the one legacy field emitted by Doom Plan before strict validation. */
export function normalizeSubagentToolParams(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (!isSubagentAction(record.action) || record.action === SUBAGENT_ACTIONS.run || typeof record.model !== 'string') {
    return input;
  }
  const { model: _model, ...normalized } = record;
  return normalized;
}

const AgentScope = Type.Union([Type.Literal('user'), Type.Literal('project'), Type.Literal('both')]);

const RunRequest = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    inlineAgent: Type.Optional(InlineAgentSchema),
    task: Type.String({ minLength: 1 }),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
    runtime: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const AgentsParams = Type.Object(
  {
    action: Type.Literal(SUBAGENT_ACTIONS.agents),
    name: Type.Optional(Type.String({ minLength: 1 })),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    scope: Type.Optional(AgentScope),
  },
  { additionalProperties: false },
);

const RunParams = Type.Object(
  {
    action: Type.Literal(SUBAGENT_ACTIONS.run),
    requests: Type.Array(RunRequest, { minItems: 1 }),
    concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    artifacts: Type.Optional(Type.Boolean()),
    scope: Type.Optional(AgentScope),
  },
  { additionalProperties: false },
);

const FleetStatusParams = Type.Object(
  { action: Type.Literal(SUBAGENT_ACTIONS.status) },
  { additionalProperties: false },
);

const RunStatusParams = Type.Object(
  {
    action: Type.Literal(SUBAGENT_ACTIONS.status),
    id: Type.String({ minLength: 1 }),
    transcriptLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

const SteerParams = Type.Object(
  {
    action: Type.Literal(SUBAGENT_ACTIONS.steer),
    id: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const StopParams = Type.Object(
  {
    action: Type.Literal(SUBAGENT_ACTIONS.stop),
    id: Type.String({ minLength: 1 }),
    reason: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const SuspendedParams = Type.Object(
  { action: Type.Literal(SUBAGENT_ACTIONS.suspended) },
  { additionalProperties: false },
);

const RestoreParams = Type.Object(
  {
    action: Type.Literal(SUBAGENT_ACTIONS.restore),
    id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const SubagentParams = Type.Union([
  AgentsParams,
  RunParams,
  FleetStatusParams,
  RunStatusParams,
  SteerParams,
  StopParams,
  SuspendedParams,
  RestoreParams,
]);

/** The actions that accept `field`, so the declared docs cannot drift from the validator. */
function acceptingActions(field: string): string {
  return Object.values(SUBAGENT_ACTIONS)
    .filter((action) => subagentActionAcceptsField(action, field))
    .join(', ');
}

/**
 * The schema declared to the model.
 *
 * A flat object rather than `SubagentParams` itself. A top-level union is
 * `{anyOf:[...]}` with no `properties`, and Pi's Anthropic Messages adapter
 * rebuilds tool input as `{type:'object', properties: schema.properties ?? {},
 * required: schema.required ?? []}`, so the union arrived at the model as an
 * empty object while the host went on validating calls against it. Nothing here
 * relaxes what is accepted: `validateParams` still rejects an unknown action, a
 * field the action does not take, and a missing required one.
 */
export const SubagentToolSchema = Type.Object(
  {
    action: Type.String({
      enum: Object.values(SUBAGENT_ACTIONS),
      description: 'The operation to run. Every other field is accepted only by the actions its description names.',
    }),
    name: Type.Optional(
      Type.String({ minLength: 1, description: `Exact agent name to inspect. Actions: ${acceptingActions('name')}.` }),
    ),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        description: `Directory to discover agents in. Actions: ${acceptingActions('cwd')}.`,
      }),
    ),
    scope: Type.Optional(
      Type.String({
        enum: ['user', 'project', 'both'],
        description: `Agent discovery scope. Actions: ${acceptingActions('scope')}.`,
      }),
    ),
    requests: Type.Optional(
      Type.Array(RunRequest, {
        minItems: 1,
        description: `Runs to start, one entry each. Actions: ${acceptingActions('requests')}.`,
      }),
    ),
    concurrency: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: `Maximum runs started at once. Actions: ${acceptingActions('concurrency')}.`,
      }),
    ),
    artifacts: Type.Optional(
      Type.Boolean({ description: `Collect run artifacts. Actions: ${acceptingActions('artifacts')}.` }),
    ),
    id: Type.Optional(Type.String({ minLength: 1, description: `Run id. Actions: ${acceptingActions('id')}.` })),
    transcriptLines: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 500,
        description: `Transcript lines to include; valid only alongside id. Actions: ${acceptingActions('transcriptLines')}.`,
      }),
    ),
    message: Type.Optional(
      Type.String({ minLength: 1, description: `Guidance to deliver. Actions: ${acceptingActions('message')}.` }),
    ),
    reason: Type.Optional(
      Type.String({ minLength: 1, description: `Why the run is stopping. Actions: ${acceptingActions('reason')}.` }),
    ),
  },
  { additionalProperties: false },
);

export type SubagentToolParams = Static<typeof SubagentParams>;
