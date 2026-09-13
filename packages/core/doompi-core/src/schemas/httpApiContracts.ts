import { Type, type TSchema } from 'typebox';

import { API_BASE_PATH, ITEM_ROUTE } from '../constants/contextApi';
import type { DoomHttpContract } from './apiContracts';

const Text = Type.String();
const Optional = Type.Optional;
const Strings = Type.Array(Text);
const Flag = Type.Boolean();
const NumberValue = Type.Number();
export const ApiErrorSchema = Type.Object({ error: Text, hash: Optional(Text) });
export const ApiOkSchema = Type.Object({ ok: Type.Literal(true) });
const Json = Type.Unknown({ description: 'Value whose schema is supplied by the selected runtime contribution.' });

/** Common JSON response construction; status and payload remain explicit at the declaration. */
export function jsonApiResponses(schema: object | boolean, status = 200): DoomHttpContract['responses'] {
  return {
    [status]: { description: 'Successful response', contentType: 'application/json', schema },
    '400': { description: 'Invalid request', schema: ApiErrorSchema },
    '401': { description: 'Authentication required', schema: ApiErrorSchema },
    '403': { description: 'Request is not authorized', schema: ApiErrorSchema },
    '404': { description: 'Resource or capability unavailable', schema: ApiErrorSchema },
    '409': { description: 'Conflicting state', schema: ApiErrorSchema },
    '422': { description: 'Invalid operation', schema: ApiErrorSchema },
    '500': { description: 'Host operation failed', schema: ApiErrorSchema },
    '502': { description: 'Provider failed', schema: ApiErrorSchema },
    '503': { description: 'Service unavailable', schema: ApiErrorSchema },
  };
}
export const WebCompositionSchema = Type.Object({
  id: Text,
  scope: Type.Union([Type.Literal('global'), Type.Literal('workspace'), Type.Literal('session')]),
  revision: NumberValue,
  manifestUrl: Text,
  rawAssetBaseUrl: Text,
  verifiedAssetBaseUrl: Text,
  entryPath: Text,
  stylePaths: Strings,
  channels: Strings,
});
export const SessionSummarySchema = Type.Object({
  id: Text,
  workspaceId: Optional(Text),
  webComposition: Optional(WebCompositionSchema),
  name: Text,
  cwd: Text,
  createdAt: Text,
  updatedAt: Text,
  phase: Type.Union([Type.Literal('idle'), Type.Literal('turn'), Type.Literal('compaction'), Type.Literal('retry')]),
  phaseSince: Text,
  attach: Type.Literal('attached'),
  pendingMessageCount: NumberValue,
  everPrompted: Flag,
  awaitingInput: Flag,
  lastSettledAt: Optional(Text),
  parentSessionId: Optional(Text),
  sessionProvenance: Optional(Text),
});
export const HubSnapshotFrameSchema = Type.Object({
  type: Type.Literal('sessions_snapshot'),
  sessions: Type.Array(SessionSummarySchema),
});
export const HubUpsertFrameSchema = Type.Object({
  type: Type.Literal('session_upsert'),
  session: SessionSummarySchema,
});
export const HubRemovedFrameSchema = Type.Object({ type: Type.Literal('session_removed'), sessionId: Text });
const Workspace = Type.Object({ id: Text, root: Text });
const SavedSession = Type.Object({
  id: Text,
  name: Optional(Text),
  firstMessage: Text,
  createdAt: Text,
  updatedAt: Text,
  messageCount: NumberValue,
});
const query = (
  name: string,
  schema: TSchema = Text,
  required = false,
): NonNullable<DoomHttpContract['parameters']>[number] => ({ name, in: 'query', required, schema });
const body = (schema: TSchema): NonNullable<DoomHttpContract['body']> => ({
  contentType: 'application/json',
  required: true,
  schema,
});
const host = (
  id: string,
  path: string,
  method: DoomHttpContract['method'],
  result: TSchema,
  extra: Partial<DoomHttpContract> = {},
): DoomHttpContract => ({
  id,
  path,
  method,
  scope: 'global',
  authentication: 'owner',
  description: id,
  responses: jsonApiResponses(result),
  ...extra,
});
const Binary = Type.String({ contentEncoding: 'binary' });
export const headlessHttpContracts: DoomHttpContract[] = [
  host(
    'health',
    '/api/health',
    'GET',
    Type.Object({
      ok: Type.Literal(true),
      role: Type.Literal('hub'),
      protocol: Type.Literal(1),
      sessions: NumberValue,
    }),
    { authentication: 'none' },
  ),
  host('telemetry.browser', '/api/telemetry/browser', 'POST', ApiOkSchema, {
    body: body(
      Type.Object({
        v: Type.Literal(1),
        events: Type.Array(
          Type.Object({
            name: Type.String({ pattern: '^web\\.browser\\.[a-z_]{1,40}$' }),
            duration_ms: Optional(NumberValue),
            count: Optional(NumberValue),
          }),
          { maxItems: 10 },
        ),
      }),
    ),
  }),
  host(
    'compositions',
    '/api/compositions',
    'GET',
    Type.Object({
      global: Optional(WebCompositionSchema),
      publicKey: Optional(Text),
      shell: Optional(Type.Object({ publicKey: Text, revision: NumberValue })),
      workspaces: Type.Array(Type.Object({ id: Text, root: Text, webComposition: Optional(WebCompositionSchema) })),
    }),
  ),
  host('directories', '/api/directories', 'GET', Type.Object({ directories: Strings }), { parameters: [query('q')] }),
  host('sessions.list', '/api/sessions', 'GET', Type.Object({ sessions: Type.Array(SessionSummarySchema) })),
  host('sessions.create', '/api/sessions', 'POST', Type.Object({ sessionId: Text }), {
    body: body(Type.Object({ cwd: Type.String({ minLength: 1 }), name: Optional(Text) })),
    responses: jsonApiResponses(Type.Object({ sessionId: Text }), 201),
  }),
  host('sessions.get', '/api/sessions/{sessionId}', 'GET', SessionSummarySchema),
  host('sessions.delete', '/api/sessions/{sessionId}', 'DELETE', ApiOkSchema),
  host(
    'sessions.history',
    '/api/sessions/{sessionId}/history',
    'GET',
    Type.Object({ sessions: Type.Array(SavedSession) }),
    { availability: 'Host provides sessionHistory' },
  ),
  host('sessions.restart', '/api/sessions/{sessionId}/restart', 'POST', ApiOkSchema, {
    availability: 'Host provides restartSession',
  }),
  host('sessions.resume', '/api/sessions/{sessionId}/resume', 'POST', Type.Object({ sessionId: Text }), {
    availability: 'Host provides resumeSession',
    body: body(Type.Object({ targetSessionId: Type.String({ pattern: '^[A-Za-z0-9_-]+$' }) })),
  }),
  host('sessions.file', '/api/sessions/{sessionId}/file', 'GET', Binary, {
    parameters: [query('path', Text, true)],
    responses: {
      ...jsonApiResponses(Binary),
      '200': { description: 'File bytes, MIME type follows the file extension', contentType: '*/*', schema: Binary },
    },
  }),
  host(
    'sessions.channels',
    '/api/sessions/{sessionId}/channels',
    'GET',
    Type.Object({ channels: Type.Array(Type.Object({ type: Text, sessionId: Text, payload: Json })) }),
  ),
  host('sessions.channel.send', '/api/sessions/{sessionId}/channel/{frameType}', 'POST', ApiOkSchema, {
    body: body(Json),
    responses: jsonApiResponses(ApiOkSchema, 202),
    description: 'Deliver a payload to the selected channel contract identified by frameType.',
  }),
  host('workspaces.list', '/api/workspaces', 'GET', Type.Object({ workspaces: Type.Array(Workspace) })),
  host('workspaces.admit', '/api/workspaces', 'POST', Type.Object({ workspace: Workspace }), {
    body: body(Type.Object({ root: Text })),
    responses: jsonApiResponses(Type.Object({ workspace: Workspace }), 201),
  }),
  host('workspaces.remove', '/api/workspaces/{workspaceId}', 'DELETE', ApiOkSchema),
  host('events', '/api/events', 'GET', Text, {
    responses: {
      '200': {
        description:
          'SSE sessions_snapshot, session_upsert, session_removed and selected channel frames. Selected extension channel payloads are defined by the corresponding AsyncAPI channel operations.',
        events: {
          sessions_snapshot: HubSnapshotFrameSchema,
          session_upsert: HubUpsertFrameSchema,
          session_removed: HubRemovedFrameSchema,
        },
        contentType: 'text/event-stream',
        schema: Text,
      },
      '401': { description: 'Authentication required', schema: ApiErrorSchema },
    },
  }),
];
const AuthType = Type.Union([Type.Literal('api_key'), Type.Literal('oauth')]);
const Provider = Type.Object({
  id: Text,
  name: Text,
  methods: Type.Array(Type.Object({ type: AuthType, label: Text })),
  authenticated: Optional(Type.Object({ type: AuthType, source: Optional(Text) })),
});
const LoginEvent = Type.Union([
  Type.Object({
    type: Type.Literal('info'),
    message: Text,
    links: Optional(Type.Array(Type.Object({ url: Text, label: Optional(Text) }))),
  }),
  Type.Object({ type: Type.Literal('auth_url'), url: Text, instructions: Optional(Text) }),
  Type.Object({
    type: Type.Literal('device_code'),
    userCode: Text,
    verificationUri: Text,
    intervalSeconds: Optional(NumberValue),
    expiresInSeconds: Optional(NumberValue),
  }),
  Type.Object({ type: Type.Literal('progress'), message: Text }),
]);
export const LoginFlowSchema = Type.Object({
  id: Text,
  providerId: Text,
  providerName: Text,
  type: AuthType,
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ]),
  events: Type.Array(LoginEvent),
  prompt: Optional(
    Type.Object({
      id: Text,
      type: Type.Union([
        Type.Literal('text'),
        Type.Literal('secret'),
        Type.Literal('select'),
        Type.Literal('manual_code'),
      ]),
      message: Text,
      placeholder: Optional(Text),
      options: Optional(Type.Array(Type.Object({ id: Text, label: Text, description: Optional(Text) }))),
    }),
  ),
  remote: Optional(Flag),
  error: Optional(Text),
});
const Flow = Type.Object({ flow: LoginFlowSchema });
export const machineHttpContracts: DoomHttpContract[] = [
  host('providers.list', '/providers', 'GET', Type.Object({ providers: Type.Array(Provider) })),
  host(
    'models.list',
    '/models',
    'GET',
    Type.Object({ models: Type.Array(Type.Object({ value: Text, label: Text, group: Text })) }),
  ),
  host('providers.logout', '/providers/{providerId}', 'DELETE', ApiOkSchema),
  host('logins.create', '/logins', 'POST', Flow, {
    body: body(Type.Object({ providerId: Text, type: AuthType })),
    responses: jsonApiResponses(Flow, 201),
  }),
  host('logins.get', '/logins/{flowId}', 'GET', Flow),
  host('logins.cancel', '/logins/{flowId}', 'DELETE', Flow),
  host('logins.answer', '/logins/{flowId}/answer', 'POST', Flow, {
    body: body(Type.Object({ promptId: Text, value: Text })),
  }),
].map((route) => ({ ...route, basePath: 'doompi' }));
const Source = Type.Union([
  Type.Literal('extension'),
  Type.Literal('mcp'),
  Type.Literal('plugin'),
  Type.Literal('core'),
]);
const Detail = Type.Union([
  Type.Object({
    itemKind: Type.Literal('tool'),
    name: Text,
    owner: Text,
    source: Source,
    active: Flag,
    tokens: Type.Object({ schemaTokens: NumberValue, promptTokens: NumberValue, totalTokens: NumberValue }),
    description: Optional(Text),
    promptSnippet: Optional(Text),
    promptGuidelines: Optional(Strings),
    parameters: Optional(Json),
  }),
  Type.Object({
    itemKind: Type.Literal('skill'),
    name: Text,
    owner: Text,
    source: Source,
    active: Type.Literal(true),
    tokens: NumberValue,
    description: Text,
    filePath: Optional(Text),
    modelInvocable: Flag,
  }),
]);
export const sessionHttpContracts: DoomHttpContract[] = [
  {
    ...host('context.item', ITEM_ROUTE, 'GET', Type.Object({ revision: NumberValue, item: Detail }), {
      parameters: [
        query('kind', Type.Union([Type.Literal('tool'), Type.Literal('skill')]), true),
        query('name', Text, true),
      ],
    }),
    scope: 'session',
    basePath: API_BASE_PATH,
  },
  {
    ...host('files.complete', '/', 'GET', Type.Object({ files: Strings }), {
      parameters: [query('q', Type.String({ maxLength: 256 }))],
    }),
    scope: 'session',
    basePath: 'files',
  },
];
