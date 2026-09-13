import { defineApiContract, jsonApiResponses } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

const S = Type.String();
const N = Type.Number();
const B = Type.Boolean();
const O = Type.Optional;
const literals = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const Run = Type.Object({
  id: S,
  name: S,
  pid: N,
  command: S,
  cwd: S,
  interactive: B,
  backend: literals(['rmux', 'tmux', 'native']),
  state: literals(['running', 'completed']),
  promoted: B,
  startedAt: S,
  logPath: S,
  exit: O(
    Type.Object({
      reason: literals(['completed', 'failed', 'signaled', 'stopped', 'timed_out', 'launcher_error', 'backend_lost']),
      code: Type.Union([N, Type.Null()]),
      signal: Type.Union([S, Type.Null()]),
      stopReason: O(S),
      finishedAt: S,
    }),
  ),
});
export const RunnerPayloadSchema = Type.Object({ runs: Type.Array(Run) });
export const RunnerLogSchema = Type.Object({
  runId: S,
  running: B,
  text: S,
  lineCount: N,
  totalLines: N,
  fileSize: N,
  completeBytes: N,
  path: S,
  exists: B,
  lineNumbers: O(Type.Array(N)),
});
export const RunnerAppendSchema = Type.Object({ lines: Type.Array(S), offset: O(N), ended: O(B) });
export const RunnerScreenSchema = Type.Object({ chunk: S, offset: O(N), ended: O(B) });
export const apiContracts = defineApiContract({
  version: 1,
  dynamic: [],
  http: [
    {
      id: 'runner.log',
      scope: 'session',
      basePath: 'runner',
      path: '/runners/{runId}/log',
      method: 'GET',
      authentication: 'owner',
      description: 'Read a runner log tail or literal substring search.',
      parameters: ['lines', 'grep', 'ignoreCase', 'contextLines'].map((name) => ({
        name,
        in: 'query',
        required: false,
        schema: S,
      })),
      responses: jsonApiResponses(RunnerLogSchema),
    },
    ...(['log', 'screen'] as const).map((kind) => ({
      id: `runner.${kind}.stream`,
      scope: 'session' as const,
      basePath: 'runner',
      path: `/runners/{runId}/${kind}/stream`,
      method: 'GET' as const,
      authentication: 'owner' as const,
      description: `Follow runner ${kind}. SSE data is JSON; ping events carry empty data.`,
      parameters: [{ name: 'from', in: 'query' as const, required: false, schema: N }],
      responses: {
        '200': {
          description: 'Event stream.',
          contentType: 'text/event-stream',
          schema: S,
          events: {
            [kind === 'log' ? 'append' : 'screen']: kind === 'log' ? RunnerAppendSchema : RunnerScreenSchema,
            ping: Type.Literal(''),
          },
        },
        '404': { description: 'Runner unavailable.', schema: Type.Object({ error: S }) },
      },
    })),
    {
      id: 'runner.input',
      scope: 'session',
      basePath: 'runner',
      path: '/runners/{runId}/screen/input',
      method: 'POST',
      authentication: 'owner',
      description: 'Send text to an interactive runner.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({ text: Type.String({ minLength: 1 }) }),
      },
      responses: jsonApiResponses(Type.Object({ delivered: Type.Literal(true) })),
    },
  ],
  sockets: (['global', 'workspace'] as const).map((scope) => ({
    id: 'runner.channel',
    scope,
    service: 'doompi.hub.v1',
    member: 'runner_runs',
    kind: 'channel',
    direction: 'server-to-client',
    description: 'Runner channel payload in the hub frame payload property.',
    input: RunnerPayloadSchema,
  })),
});
export default apiContracts;
