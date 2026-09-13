import { Type, type TSchema } from 'typebox';

import type { DoomHttpContract } from './apiContracts';
import { ApiErrorSchema, ApiOkSchema, jsonApiResponses } from './httpApiContracts';

const Text = Type.String();
const NumberValue = Type.Number();
const Optional = Type.Optional;
const Flag = Type.Boolean();
const JsonObject = Type.Record(
  Text,
  Type.Unknown({
    description: 'WebAuthn ceremony fields supplied and verified by the installed WebAuthn implementation.',
  }),
);
const Tunnel = Type.Union([
  Type.Object({ kind: Type.Literal('quick') }),
  Type.Object({
    kind: Type.Literal('named'),
    hostname: Text,
    name: Optional(Text),
    tokenFile: Optional(Text),
    configFile: Optional(Text),
  }),
]);
const Settings = Type.Object({
  autoCloseEnabled: Flag,
  autoCloseMinutes: NumberValue,
  sessionExpiryEnabled: Flag,
  idleMinutes: NumberValue,
  absoluteHours: NumberValue,
  tunnel: Tunnel,
  sandbox: Type.Object({ enabled: Flag, workspaces: Type.Array(Text) }),
});
const State = Type.Object({
  status: Type.Union([Type.Literal('off'), Type.Literal('starting'), Type.Literal('on'), Type.Literal('failed')]),
  publicUrl: Optional(Text),
  startedAt: Optional(Text),
  closesAt: Optional(Text),
  error: Optional(Text),
  devices: Type.Array(
    Type.Object({ id: Text, label: Text, userAgent: Text, createdAt: Text, lastSeenAt: Text, self: Flag }),
  ),
  pending: Type.Array(Type.Object({ id: Text, userAgent: Text, edgeIp: Text, createdAt: Text, expiresAt: Text })),
  settings: Settings,
});
const StateResponse = Type.Object({ state: State, handingOver: Optional(Flag) });
const Trust = Type.Object({ publicKey: Text, fingerprint: Text, revision: NumberValue });
const Begun = Type.Object({ ceremonyId: Text, options: JsonObject });
const Finish = Type.Object({ ceremonyId: Text, response: JsonObject });
export const SealedEnvelopeSchema = Type.Object({ v: Type.Literal(1), n: Text, c: Text });
export const SealedHttpRequestSchema = Type.Object({
  v: Type.Literal(1),
  method: Text,
  target: Text,
  headers: Type.Array(Type.Tuple([Text, Text])),
  body: Optional(Text),
});
export const SealedHttpResponseSchema = Type.Object({
  v: Type.Literal(1),
  status: NumberValue,
  headers: Type.Array(Type.Tuple([Text, Text])),
  body: Text,
});
const route = (
  id: string,
  path: string,
  method: DoomHttpContract['method'],
  result: TSchema,
  input?: TSchema,
  extra: Partial<DoomHttpContract> = {},
): DoomHttpContract => ({
  id: `remote.${id}`,
  path: `/api/remote${path}`,
  method,
  scope: 'global',
  authentication: 'owner',
  description: `Remote Control ${id}.`,
  availability:
    'Global host provides Remote Control. Tunnel routes additionally enforce device, origin and step-up policy.',
  responses: { ...jsonApiResponses(result), '429': { description: 'Rate limit exceeded', schema: ApiErrorSchema } },
  ...(input ? { body: { contentType: 'application/json', required: true, schema: input } } : {}),
  ...extra,
});
const direct: DoomHttpContract[] = [
  route('state', '', 'GET', StateResponse),
  route('enable', '/enable', 'POST', StateResponse, undefined, {
    responses: {
      ...jsonApiResponses(StateResponse),
      '202': { description: 'Container handover started', schema: StateResponse },
    },
  }),
  route('disable', '/disable', 'POST', StateResponse, undefined, {
    responses: {
      ...jsonApiResponses(StateResponse),
      '202': { description: 'Tunnel closing', schema: Type.Object({ status: Type.Literal('closing') }) },
    },
  }),
  route(
    'codes',
    '/codes',
    'POST',
    Type.Object({ ...Trust.properties, code: Text, manualCode: Text, pairUrl: Text, expiresAt: Text }),
    undefined,
    {
      responses: jsonApiResponses(
        Type.Object({ ...Trust.properties, code: Text, manualCode: Text, pairUrl: Text, expiresAt: Text }),
        201,
      ),
    },
  ),
  route('approve', '/pairing/{id}/approve', 'POST', StateResponse),
  route('deny', '/pairing/{id}/deny', 'POST', StateResponse),
  route('revoke', '/devices/{id}', 'DELETE', StateResponse),
  route('settings', '/settings', 'PUT', Type.Object({ settings: Settings }), Type.Partial(Settings)),
  route(
    'passkeys',
    '/passkeys',
    'GET',
    Type.Object({
      support: Type.Union([
        Type.Object({ supported: Type.Literal(true), rpId: Text }),
        Type.Object({ supported: Type.Literal(false), reason: Text }),
      ]),
      credentials: Type.Array(Type.Object({ id: Text, label: Text, createdAt: Text, lastUsedAt: Text })),
    }),
  ),
  route('passkeys.remove', '/passkeys/{id}', 'DELETE', ApiOkSchema),
  route('register.begin', '/passkeys/register/begin', 'POST', Begun, undefined, { authentication: 'device' }),
  route('register.finish', '/passkeys/register/finish', 'POST', Type.Object({ id: Text }), Finish, {
    authentication: 'device',
  }),
  route('authenticate.begin', '/passkeys/authenticate/begin', 'POST', Begun, undefined, { authentication: 'none' }),
  route(
    'authenticate.finish',
    '/passkeys/authenticate/finish',
    'POST',
    Type.Object({ ok: Type.Literal(true), hostPublicKey: Text }),
    Finish,
    { authentication: 'none' },
  ),
  route('challenge', '/challenge', 'POST', Begun, Type.Object({ action: Text }), { authentication: 'device' }),
  route(
    'channel',
    '/channel',
    'POST',
    ApiOkSchema,
    Type.Object({
      clientPublicKey: Text,
      scope: Type.Union([Type.Literal('session'), Type.Literal('protocol'), Type.Literal('http')]),
    }),
    { authentication: 'device' },
  ),
  route('request', '/request', 'POST', SealedEnvelopeSchema, SealedEnvelopeSchema, {
    authentication: 'device',
    description:
      'Sealed HTTP gateway. Decrypted requests/responses use the SealedHttpRequest and SealedHttpResponse envelopes.',
  }),
  route(
    'pair',
    '/pair',
    'POST',
    Type.Object({ requestId: Text, status: Type.Literal('pending') }),
    Type.Object({ code: Type.String({ minLength: 1 }) }),
    {
      authentication: 'none',
      responses: {
        ...jsonApiResponses(Type.Object({ requestId: Text, status: Type.Literal('pending') }), 202),
        '410': { description: 'Pairing code is no longer valid', schema: ApiErrorSchema },
      },
    },
  ),
  route(
    'pair.status',
    '/pair/status',
    'GET',
    Type.Object({
      status: Type.Union([
        Type.Literal('pending'),
        Type.Literal('approved'),
        Type.Literal('denied'),
        Type.Literal('expired'),
        Type.Literal('consumed'),
      ]),
      bundleTrust: Optional(Trust),
      hostPublicKey: Optional(Text),
    }),
    undefined,
    { authentication: 'none', parameters: [{ name: 'request', in: 'query', required: true, schema: Text }] },
  ),
];
export const remoteHttpContracts: DoomHttpContract[] = [
  route('frontend', '/frontend', 'POST', ApiOkSchema, Type.Object({ origin: Text }), {
    authentication: 'owner',
    availability: 'Internal loopback frontend registration; blocked by the browser proxy.',
    parameters: [{ name: 'x-doompi-web-registration', in: 'header', required: true, schema: Text }],
  }),
  ...direct,
  ...direct.map((operation) => ({
    ...operation,
    id: `${operation.id}.plugin`,
    basePath: 'remote',
    path: operation.path.slice('/api/remote'.length) || '/',
    authentication: 'owner' as const,
    availability: 'Global Remote Control plugin mount, reached through the authenticated headless listener.',
  })),
  {
    id: 'remote.pair.page',
    scope: 'global',
    path: '/pair',
    method: 'GET',
    authentication: 'none',
    availability: 'Remote listener only',
    description: 'Pairing and passkey bootstrap page.',
    responses: { '200': { description: 'Pairing page', contentType: 'text/html', schema: Text } },
  },
];
const Asset = Type.Object({
  path: Text,
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  byteLength: Type.Integer({ minimum: 0 }),
  contentType: Text,
});
const Signed = Type.Object({
  manifest: Type.Object({
    version: Type.Literal(2),
    revision: Type.Integer({ minimum: 1 }),
    builtAt: NumberValue,
    assets: Type.Array(Asset),
  }),
  signature: Text,
  publicKey: Text,
});
export const bundleHttpContracts: DoomHttpContract[] = [
  ...['/bundle-manifest.json', '/api/web-plugins/{id}/{revision}/manifest'].flatMap((path) =>
    (['GET', 'HEAD'] as const).map((method): DoomHttpContract => ({
      id: `bundle.${path}.${method}`,
      scope: 'global',
      path,
      method,
      authentication: 'owner',
      availability: 'Host publishes a web bundle',
      description: 'Read an immutable signed browser bundle manifest.',
      responses:
        method === 'HEAD'
          ? { '200': { description: 'Manifest response headers' }, '404': { description: 'Bundle not published' } }
          : jsonApiResponses(Signed),
    })),
  ),
  ...['/bundle-assets/{revision}/{assetPath}', '/api/web-plugins/{id}/{revision}/assets/{assetPath}'].flatMap((path) =>
    (['GET', 'HEAD'] as const).map((method): DoomHttpContract => ({
      id: `asset.${path}.${method}`,
      scope: 'global',
      path,
      method,
      authentication: 'owner',
      availability: 'Host publishes a web bundle',
      description: 'Read an asset from the signed manifest. assetPath may contain multiple path segments.',
      responses: {
        '200': {
          description: 'Manifest-listed asset, original MIME type',
          ...(method === 'GET' ? { contentType: '*/*', schema: Type.String({ contentEncoding: 'binary' }) } : {}),
        },
        '404': { description: 'Asset not published' },
      },
    })),
  ),
];
