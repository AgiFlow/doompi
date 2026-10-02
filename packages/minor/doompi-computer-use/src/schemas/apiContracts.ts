import { defineApiContract, jsonApiResponses, type DoomHttpContract } from '@agimon-ai/doompi-core/apiContracts';
import { Type } from 'typebox';

const S = Type.String();
const N = Type.Number();
const O = Type.Optional;
const values = <T extends string>(items: T[]) => Type.Union(items.map((item) => Type.Literal(item)));
const Json = Type.Unknown({
  description:
    'Desktop provider JSON value. Targets, observations and action results are supplied by the admitted Desktop provider.',
});
const Target = Type.Record(S, Json);
const Error = Type.Object({ code: S, message: S });
const Artifact = Type.Object({
  artifactId: S,
  status: values(['ready', 'failed']),
  sizeBytes: O(N),
  downloadUrl: O(S),
  previewUrl: O(S),
  actionCount: O(N),
  completedAt: O(S),
  failure: O(Error),
});
export const ComputerStateSchema = Type.Object({
  sessionId: S,
  revision: N,
  wake: N,
  phase: values(['inactive', 'awaiting_confirmation', 'activating', 'active', 'stopping', 'failed']),
  requestId: O(S),
  target: O(Target),
  durationMs: O(N),
  expiresAt: O(N),
  failure: O(Error),
  artifact: O(Artifact),
});
const Reference = { snapshotId: Type.String({ minLength: 1 }), elementRef: Type.String({ minLength: 1 }) };
export const ComputerActionSchema = Type.Union([
  Type.Object({ kind: values(['press', 'focus']), ...Reference }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('set_value'), ...Reference, value: S }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('scroll'),
      ...Reference,
      direction: values(['up', 'down', 'left', 'right']),
      amount: values(['line', 'page']),
    },
    { additionalProperties: false },
  ),
]);
const internal = (
  method: 'GET' | 'POST',
  path: string,
  output: object,
  body?: object,
  status = 200,
): DoomHttpContract => ({
  id: `computer.${path.slice(1).replaceAll('/', '.')}`,
  scope: 'session',
  basePath: 'computer-use',
  path,
  method,
  authentication: 'owner',
  description: `Computer use broker ${path}. Requires the host-issued ${path.startsWith('/agent/') ? 'agent' : 'hub'} bearer token.`,
  availability: 'Internal broker route; ordinary browser credentials are insufficient.',
  parameters: [{ name: 'Authorization', in: 'header', required: true, schema: Type.String({ pattern: '^Bearer .+' }) }],
  ...(body ? { body: { required: true, contentType: 'application/json', schema: body } } : {}),
  responses: jsonApiResponses(output, status),
});
export const apiContracts = defineApiContract({
  version: 1,
  dynamic: ['Desktop provider target extensions, observations and operation results are runtime-defined JSON.'],
  http: [
    {
      id: 'computer.activation.state',
      scope: 'session',
      basePath: 'computer-use',
      path: '/activate',
      method: 'GET',
      authentication: 'owner',
      description: 'Read state as the matching pending requester or approved recording reader.',
      responses: jsonApiResponses(ComputerStateSchema),
    },
    {
      id: 'computer.activation.cancel',
      scope: 'session',
      basePath: 'computer-use',
      path: '/activate',
      method: 'DELETE',
      authentication: 'owner',
      description: 'Cancel only the matching requester pending activation.',
      responses: jsonApiResponses(ComputerStateSchema, 202),
    },
    {
      id: 'computer.activate',
      scope: 'session',
      basePath: 'computer-use',
      path: '/activate',
      method: 'POST',
      authentication: 'owner',
      description:
        'Request confirmed Desktop access with admitted caller and remote step-up context. A remote caller may omit target so the local Mac selects the window.',
      body: {
        required: true,
        contentType: 'application/json',
        schema: Type.Object({
          target: O(Type.Object({ windowId: S, bundleId: S })),
          durationMs: Type.Integer({ minimum: 1000, maximum: 1800000 }),
        }),
      },
      responses: jsonApiResponses(ComputerStateSchema, 202),
    },
    {
      id: 'computer.artifact',
      scope: 'session',
      basePath: 'computer-use',
      path: '/artifact',
      method: 'GET',
      authentication: 'owner',
      description: 'Read at most 1 MiB of a recording belonging to this session and approved caller.',
      parameters: [
        { name: 'artifactId', in: 'query', required: true, schema: S },
        { name: 'offset', in: 'query', required: true, schema: Type.Integer({ minimum: 0 }) },
      ],
      responses: {
        206: {
          description: 'Bounded recording bytes.',
          contentType: 'video/mp4',
          schema: Type.String({ format: 'binary' }),
        },
      },
    },
    internal('GET', '/agent/state', ComputerStateSchema),
    internal('GET', '/hub/state', ComputerStateSchema),
    internal('POST', '/agent/observe', Json),
    internal('POST', '/agent/action', Json, ComputerActionSchema),
    internal('POST', '/agent/stop', ComputerStateSchema, undefined, 202),
    internal(
      'GET',
      '/hub/activation',
      Type.Union([
        Type.Null(),
        Type.Object({
          requestId: S,
          target: Target,
          durationSeconds: N,
          createdAt: N,
          confirmationExpiresAt: N,
          caller: Type.Object({ locality: values(['local', 'remote']), stepUp: S }),
        }),
      ]),
    ),
    internal('GET', '/hub/authorization', Type.Union([Type.Null(), Type.Object({ grantId: S, expiresAt: O(N) })])),
    internal(
      'GET',
      '/hub/next',
      Type.Union([
        Type.Null(),
        Type.Object({ id: S, operation: values(['observe', 'act']), payload: O(Json), grantId: S, sequence: O(N) }),
      ]),
    ),
    internal('POST', '/hub/complete', ComputerStateSchema, Type.Object({ id: S, error: O(S), result: O(Json) })),
    internal(
      'POST',
      '/hub/stop',
      ComputerStateSchema,
      Type.Object({ error: O(S), host: O(Type.Object({ grantId: S, expiresAt: N })), artifact: O(Artifact) }),
    ),
  ],
  sockets: (['global', 'workspace'] as const).flatMap((scope) => [
    {
      id: 'computer.state',
      scope,
      service: 'doompi.hub.v1',
      member: 'computer_use_state',
      kind: 'channel',
      direction: 'server-to-client',
      description: 'Computer use channel payload.',
      input: Type.Object({ state: ComputerStateSchema, targets: Type.Array(Target), busy: O(Type.Literal(true)) }),
    },
    {
      id: 'computer.command',
      scope,
      service: 'doompi.hub.v1',
      member: 'computer_use_state',
      kind: 'channel',
      direction: 'client-to-server',
      description: 'Computer use browser channel command.',
      input: Type.Object({ action: values(['status', 'targets', 'stop', 'artifacts']) }),
    },
  ]),
});
export default apiContracts;
