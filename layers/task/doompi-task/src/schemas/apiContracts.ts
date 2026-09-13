import { defineApiContract } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const S = Type.String();
const N = Type.Number();
const O = Type.Optional;
const literals = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
export const TasksPayloadSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: N,
      subject: S,
      description: O(S),
      activeForm: O(S),
      status: literals(['pending', 'in_progress', 'completed', 'failed', 'deleted']),
      blockedBy: Type.Array(N),
      owner: O(S),
      updatedAt: O(S),
      delegation: O(Type.Object({ agent: O(S), state: O(S) })),
    }),
  ),
  rev: N,
});
export const apiContracts = defineApiContract({
  version: 1,
  http: [],
  dynamic: [],
  sockets: (['global', 'workspace'] as const).map((scope) => ({
    id: 'tasks.channel',
    scope,
    service: 'doompi.hub.v1',
    member: 'task_graph',
    kind: 'channel',
    direction: 'server-to-client',
    description: 'Task graph channel payload.',
    input: TasksPayloadSchema,
  })),
});
export default apiContracts;
