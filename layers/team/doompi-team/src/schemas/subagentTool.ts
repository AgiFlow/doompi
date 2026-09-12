import { type Static, Type } from 'typebox';

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

const AgentScope = Type.Union([Type.Literal('user'), Type.Literal('project'), Type.Literal('both')]);

export const InlineAgentSchema = Type.Object(
  { systemPrompt: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export type InlineAgent = Static<typeof InlineAgentSchema>;

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

export type SubagentToolParams = Static<typeof SubagentParams>;
