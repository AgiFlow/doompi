import { defineApiContract, jsonApiResponses, type DoomHttpContract } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

import { AuthorBridgeMessageSchema, AuthorBridgeInputSchema, AuthorUseToolsInputSchema } from './authorFacade';

const S = Type.String();
const N = Type.Number();
const B = Type.Boolean();
const O = Type.Optional;
const Json = Type.Unknown({
  description: 'Runtime author capability value, validated against the capability catalog inputSchema.',
});
const values = <T extends string>(items: T[]) => Type.Union(items.map((item) => Type.Literal(item)));
const Capability = Type.Object({ name: S, label: S, description: S, inputSchema: Type.Record(S, Json) });
const Accepted = Type.Object({
  kind: Type.Literal('accepted'),
  generation: N,
  ownerToken: S,
  catalogToken: O(S),
  leaseMs: N,
});
const Identity = { generation: N, ownerToken: S, catalogToken: S, requestId: S };
const Request = Type.Object({ kind: Type.Literal('request'), ...Identity, name: S, arguments: Type.Record(S, Json) });
const Cancel = Type.Object({ kind: Type.Literal('cancel'), ...Identity });
export const AuthorHubMessageSchema = Type.Union([
  Accepted,
  Request,
  Cancel,
  Type.Object({ kind: Type.Literal('rejected'), reason: S }),
]);
const Binding = { bindingId: S, generation: Type.Integer({ minimum: 0 }) };
const Owner = { ...Binding, ownerToken: S };
const ResultIdentity = { ...Owner, catalogToken: S, requestId: S };
const Format = values(['markdown-slides', 'csv', 'pptx', 'xlsx']);
const Manifest = Type.Object({
  format: Format,
  sourceDigest: S,
  byteLength: N,
  fragmentCount: N,
  metadata: Type.Record(S, Type.Union([S, N, B])),
});
const Operation = { fragmentId: S, replacement: S };
const Log = Type.Array(Type.Object({ ...Operation, previous: S }));
const Document = {
  path: S,
  format: Format,
  operations: O(Type.Array(Type.Object(Operation), { maxItems: 100000 })),
  csvDialect: O(
    Type.Object({
      delimiter: O(values([',', ';', '\t', '|'])),
      quote: O(values(['"', "'"])),
      recordDelimiter: O(values(['\n', '\r\n'])),
    }),
  ),
};
const ParsedDocument = Type.Object({
  manifest: Manifest,
  fragments: Type.Array(
    Type.Object({ id: S, kind: values(['slide', 'cell', 'text-run']), text: S, readOnly: O(B), location: S }),
  ),
  renderModel: Type.Object({ format: Format, blocks: Type.Array(Type.Object({ id: S, text: S, readOnly: B })) }),
});
const post = (id: string, path: string, schema: object, output: object): DoomHttpContract => ({
  id,
  scope: 'session',
  basePath: 'author',
  path,
  method: 'POST',
  authentication: 'owner',
  description: `Author ${id}.`,
  body: { required: true, contentType: 'application/json', schema },
  responses: jsonApiResponses(output),
});
export const apiContracts = defineApiContract({
  version: 1,
  dynamic: ['Author capability catalogs supply input JSON Schemas and arbitrary JSON results at runtime.'],
  http: [
    {
      id: 'author.state',
      scope: 'session',
      basePath: 'author',
      path: '/state',
      method: 'GET',
      authentication: 'owner',
      description: 'Read author activation.',
      responses: jsonApiResponses(
        Type.Object({
          sessionId: Type.Union([S, Type.Null()]),
          activation: values(['inactive', 'active']),
          capabilityCount: N,
        }),
      ),
    },
    post('bridge.register', '/bridge/register', Type.Object(Binding), Accepted),
    post('bridge.catalog', '/bridge/catalog', Type.Object({ ...Owner, tools: Type.Array(Capability) }), Accepted),
    post('bridge.next', '/bridge/next', Type.Object(Owner), Type.Union([Request, Cancel])),
    post(
      'bridge.result',
      '/bridge/result',
      Type.Object({ ...ResultIdentity, result: Json }),
      Type.Object({ accepted: Type.Literal(true) }),
    ),
    post(
      'bridge.cancelled',
      '/bridge/cancelled',
      Type.Object(ResultIdentity),
      Type.Object({ accepted: Type.Literal(true) }),
    ),
    post(
      'bridge.disconnect',
      '/bridge/disconnect',
      Type.Object(Binding),
      Type.Object({ accepted: Type.Literal(true) }),
    ),
    {
      id: 'bridge.describe',
      scope: 'session',
      basePath: 'author',
      path: '/bridge/describe',
      method: 'GET',
      authentication: 'owner',
      description: 'Read runtime author capabilities.',
      responses: jsonApiResponses(Type.Object({ catalogToken: S, tools: Type.Array(Capability) })),
    },
    post(
      'bridge.invoke',
      '/bridge/invoke',
      AuthorUseToolsInputSchema,
      Type.Object({ catalogToken: S, name: S, result: Json }),
    ),
    post(
      'documents.open',
      '/documents/open',
      Type.Object({ ...Document, format: O(Format) }),
      Type.Union([Type.Object({ path: S, byteLength: N }), ParsedDocument]),
    ),
    post(
      'documents.preflight',
      '/documents/preflight',
      Type.Object(Document),
      Type.Object({
        accepted: B,
        digest: S,
        sourceDigest: S,
        operations: Log,
        issues: Type.Array(Type.Object({ code: S, message: S, fragmentId: O(S) })),
      }),
    ),
    post(
      'documents.serialize',
      '/documents/serialize',
      Type.Object({ ...Document, preflightDigest: S }),
      Type.Object({ bytes: S, encoding: Type.Literal('base64'), manifest: Manifest, operationLog: Log }),
    ),
  ],
  sockets: (['global', 'workspace'] as const).flatMap((scope) => [
    {
      id: 'author.send',
      scope,
      service: 'author.bridge',
      member: 'send',
      kind: 'method',
      direction: 'client-to-server',
      description: 'Scoped author bridge method invoked through doompi.plugin.v1.',
      input: AuthorBridgeInputSchema,
      output: Type.Object({}, { additionalProperties: false }),
    },
    {
      id: 'author.browser',
      scope,
      service: 'doompi.hub.v1',
      member: 'author_webmcp',
      kind: 'channel',
      direction: 'client-to-server',
      description: 'Browser author channel payload.',
      input: AuthorBridgeMessageSchema,
    },
    {
      id: 'author.hub',
      scope,
      service: 'doompi.hub.v1',
      member: 'author_webmcp',
      kind: 'channel',
      direction: 'server-to-client',
      description: 'Hub author channel payload.',
      input: AuthorHubMessageSchema,
    },
  ]),
});
export default apiContracts;
