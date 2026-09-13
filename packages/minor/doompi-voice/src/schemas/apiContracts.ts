import { defineApiContract, jsonApiResponses, type DoomHttpContract } from '@agimon-ai/doompi-core/api-contracts';
import { Type } from 'typebox';

import { voiceControlMethod } from './voiceControl';

const S = Type.String();
const N = Type.Number();
const B = Type.Boolean();
const O = Type.Optional;
const values = <T extends string>(items: T[]) => Type.Union(items.map((item) => Type.Literal(item)));
const Client = { clientId: S, connectionId: S };
const Configuration = Type.Object({
  mode: values(['manual', 'autonomous']),
  activityControl: values(['host', 'client']),
  endpointSilenceMs: O(Type.Integer({ minimum: 250 })),
});
const Playback = { playbackId: S, outcome: values(['completed', 'stopped', 'aborted', 'failed']), error: O(S) };
const Sequence = { sequence: N };
const Control = values(['mute', 'unmute', 'interrupt']);
const Browser = Type.Object({
  connection: values(['connecting', 'connected', 'closed', 'failed']),
  listening: B,
  speaking: B,
  muted: B,
  error: O(S),
});
export const VoiceMediaEventSchema = Type.Union([
  Type.Object({
    ...Sequence,
    type: Type.Literal('capture-start'),
    captureId: S,
    sampleRate: Type.Literal(16000),
    channels: Type.Literal(1),
    bitsPerSample: Type.Literal(16),
    configuration: Configuration,
  }),
  Type.Object({ ...Sequence, type: values(['capture-stop', 'capture-abort']), captureId: S }),
  Type.Object({
    ...Sequence,
    type: Type.Literal('playback-start'),
    playbackId: S,
    text: S,
    delivery: O(values(['client', 'streamed'])),
    voice: O(S),
    rate: O(N),
  }),
  Type.Object({ ...Sequence, type: values(['playback-stop', 'playback-abort']), playbackId: S }),
  Type.Object({ ...Sequence, type: values(['realtime-start', 'realtime-stop']), activationId: S }),
  Type.Object({ ...Sequence, type: Type.Literal('realtime-control'), activationId: S, action: Control }),
  Type.Object({ ...Sequence, type: Type.Literal('realtime-send'), activationId: S, messages: Type.Array(S) }),
]);
const RealtimeEvent = Type.Union([
  Type.Object({ type: Type.Literal('ready') }),
  Type.Object({ type: Type.Literal('transcript'), role: values(['user', 'assistant']), text: S, complete: B }),
  Type.Object({ type: Type.Literal('request'), requestId: S, text: S }),
  Type.Object({ type: Type.Literal('error'), code: S }),
]);
const RealtimeSnapshot = Type.Object({
  activationId: S,
  state: values(['connecting', 'active', 'closed', 'failed']),
  cursor: N,
  events: Type.Array(Type.Object({ sequence: N, event: RealtimeEvent })),
  browser: O(Browser),
});
const Wake = Type.Object({ eventEpoch: S, sequence: N });
const Version = { version: Type.Literal(2) };
const Targets = Type.Array(Type.Object({ handle: S, label: S, order: N }), { maxItems: 32 });
const OwnershipAction = values(['catalog', 'activate', 'deactivate']);
const Acknowledgement = Type.Object({
  ...Version,
  commandId: S,
  action: OwnershipAction,
  ok: B,
  active: B,
  error: O(S),
});
const Command = Type.Object({ ...Version, commandId: S, action: OwnershipAction, targets: O(Targets) });
const Snapshot = Type.Object({
  registration: O(Type.Object({ ...Version, leaseId: S, revision: N, label: S, eligible: B, active: B })),
  targets: Targets,
  activation: O(Type.Object({ ...Version, requestId: S })),
  handoff: O(Type.Object({ ...Version, requestId: S, handle: S })),
  acknowledgement: O(Acknowledgement),
});
const Errors = Object.fromEntries(
  [400, 404, 409, 410, 413, 415, 429, 500, 502, 503, 504].map((status) => [
    status,
    { description: 'Voice request failed.', schema: Type.Object({ error: S, code: O(S) }) },
  ]),
);
const route = (
  path: string,
  method: 'GET' | 'POST',
  output?: object,
  input?: object,
  query: string[] = [],
  status = 200,
): DoomHttpContract => ({
  id: `voice.${path.slice(1).replaceAll('/', '.')}`,
  scope: 'session',
  basePath: 'voice-media',
  path,
  method,
  authentication: 'owner',
  description: `Voice media ${path}.`,
  ...(path.startsWith('/host/') || path.startsWith('/hub/')
    ? { availability: 'Internal broker route; requires the host-issued bearer token for this route namespace.' }
    : {}),
  parameters: [
    ...query.map((name) => ({ name, in: 'query' as const, required: !['after', 'wait'].includes(name), schema: S })),
    ...(path.startsWith('/host/') || path.startsWith('/hub/')
      ? [
          {
            name: 'Authorization',
            in: 'header' as const,
            required: true,
            schema: Type.String({ pattern: '^Bearer .+' }),
          },
        ]
      : []),
  ],
  ...(input ? { body: { required: true, contentType: 'application/json', schema: input } } : {}),
  responses: {
    ...Errors,
    [output ? status : 204]: {
      description: output ? 'Voice response.' : 'Accepted with no response body.',
      ...(output ? { schema: output } : {}),
    },
  },
});
const pcm = (path: string, method: 'GET' | 'POST', query: string[]): DoomHttpContract => {
  const result = route(path, method, undefined, undefined, query);
  result.description =
    'PCM signed 16-bit little-endian, 16000 Hz, mono. Chunks contain complete samples. Activity headers carry state, level, elapsed time, epoch and speech duration. A 204 response carries x-doompi-capture-state or x-doompi-playback-state when applicable.';
  if (method === 'POST') result.body = { required: true, contentType: 'application/vnd.doompi.pcm-s16le', schema: S };
  else
    result.responses['200'] = { description: 'PCM bytes.', contentType: 'application/vnd.doompi.pcm-s16le', schema: S };
  return result;
};
const Inputs = Type.Array(Type.Object({ deviceId: S, groupId: S, label: S }), { maxItems: 100 });
const Settings = Type.Object({ inputs: Inputs, deviceId: Type.Union([S, Type.Null()]) });
export const apiContracts = defineApiContract({
  version: 1,
  protocols: { 'voice-media': '6', 'voice-ownership': '2' },
  dynamic: ['Realtime event strings and SDP are provider-defined protocol documents passed through the media broker.'],
  http: [
    {
      id: 'voice.status',
      scope: 'session',
      basePath: 'voice',
      path: '/status',
      method: 'GET',
      authentication: 'owner',
      description: 'Voice session status and media readiness.',
      responses: jsonApiResponses(
        Type.Object({
          ...voiceControlMethod.output.properties,
          media: Type.Object({ closed: B, capture: B, playback: B, realtime: B }),
          readiness: Type.Object({
            configured: B,
            transcription: B,
            error: O(S),
            engine: O(S),
            mode: O(S),
            correctionModel: O(S),
          }),
        }),
      ),
    },
    {
      id: 'voice.control.http',
      scope: 'session',
      basePath: 'voice',
      path: '/control',
      method: 'POST',
      authentication: 'owner',
      description: 'Control the voice session.',
      body: { required: true, contentType: 'application/json', schema: voiceControlMethod.input },
      responses: jsonApiResponses(voiceControlMethod.output),
    },
    route(
      '/client/connect',
      'POST',
      Type.Object({ version: Type.Literal(6), cursor: N, eventEpoch: O(S), heartbeatMs: O(N) }),
      Type.Object({
        version: Type.Literal(6),
        ...Client,
        clientKind: values(['browser', 'native']),
        controlLocation: values(['local', 'remote']),
        capabilities: Type.Object({
          capture: B,
          playback: B,
          captureActivity: B,
          autonomousOrchestration: B,
          playbackDucking: O(B),
          realtime: O(B),
        }),
      }),
    ),
    route('/client/disconnect', 'POST', undefined, Type.Object(Client)),
    route('/client/heartbeat', 'POST', Wake, Type.Object(Client)),
    {
      ...route('/client/events', 'GET', VoiceMediaEventSchema, undefined, [
        'clientId',
        'connectionId',
        'after',
        'wait',
      ]),
      responses: {
        ...Errors,
        '200': { description: 'Next event.', schema: VoiceMediaEventSchema },
        '204': { description: 'No pending event.' },
      },
    },
    pcm('/client/audio', 'POST', ['clientId', 'connectionId', 'captureId']),
    route('/client/capture-stopped', 'POST', undefined, Type.Object({ ...Client, captureId: S, error: O(S) })),
    pcm('/client/playback-audio', 'GET', ['clientId', 'connectionId', 'playbackId']),
    route('/client/playback-result', 'POST', undefined, Type.Object({ ...Client, ...Playback })),
    route(
      '/host/capture/start',
      'POST',
      Type.Object({ configuration: Configuration }),
      Type.Object({ captureId: S, configuration: O(Configuration) }),
      [],
      201,
    ),
    pcm('/host/capture/audio', 'GET', ['captureId']),
    ...['stop', 'abort'].map((action) =>
      route(`/host/capture/${action}`, 'POST', undefined, Type.Object({ captureId: S })),
    ),
    route(
      '/host/playback/start',
      'POST',
      Type.Object({ delivery: values(['client', 'streamed']) }),
      Type.Object({ playbackId: S, text: S, voice: O(S), rate: O(N) }),
      [],
      201,
    ),
    pcm('/host/playback/audio', 'POST', ['playbackId']),
    route('/host/playback/audio-end', 'POST', undefined, Type.Object({ playbackId: S, error: O(S) })),
    {
      ...route('/host/playback/result', 'GET', Type.Object(Playback), undefined, ['playbackId']),
      responses: {
        ...Errors,
        '200': { description: 'Playback outcome.', schema: Type.Object(Playback) },
        '204': { description: 'Playback is pending.' },
      },
    },
    ...['stop', 'abort'].map((action) =>
      route(`/host/playback/${action}`, 'POST', undefined, Type.Object({ playbackId: S })),
    ),
    route('/hub/ownership/state', 'GET', Snapshot),
    route('/hub/ownership/command', 'POST', Acknowledgement, Command),
    route('/host/ownership/sync', 'POST', Type.Object({ command: O(Command) }), Snapshot),
    route(
      '/host/realtime/start',
      'POST',
      Type.Object({}),
      Type.Object({ activationId: S, instructions: Type.String({ maxLength: 16384 }) }),
      [],
      201,
    ),
    route('/host/realtime/stop', 'POST', undefined, Type.Object({ activationId: S })),
    route('/host/realtime/poll', 'GET', RealtimeSnapshot, undefined, ['activationId', 'after']),
    route(
      '/host/realtime/send',
      'POST',
      undefined,
      Type.Object({ activationId: S, messages: Type.Array(S, { maxItems: 64 }) }),
    ),
    route('/host/realtime/control', 'POST', undefined, Type.Object({ activationId: S, action: Control })),
    route(
      '/client/realtime/negotiate',
      'POST',
      Type.Object({ sdp: S }),
      Type.Object({ ...Client, activationId: S, sdp: S }),
    ),
    route('/client/realtime/event', 'POST', undefined, Type.Object({ ...Client, activationId: S, event: S })),
    route('/client/realtime/state', 'POST', undefined, Type.Object({ ...Client, activationId: S, state: Browser })),
    {
      id: 'voice.manual',
      scope: 'session',
      basePath: 'voice-media',
      path: '/manual/transcribe',
      method: 'POST',
      authentication: 'owner',
      description: 'Transcribe at most 4 MiB of WebM/Opus or MP4/AAC audio, at most 300000 milliseconds.',
      parameters: [
        {
          name: 'x-doom-audio-duration-ms',
          in: 'header',
          required: true,
          schema: Type.Integer({ minimum: 0, maximum: 300000 }),
        },
      ],
      body: { required: true, contentType: 'audio/webm', contentTypes: ['audio/webm', 'audio/mp4'], schema: S },
      responses: { ...Errors, '200': { description: 'Transcript.', schema: Type.Object({ transcript: S }) } },
    },
    ...(['global'] as const).flatMap((scope): DoomHttpContract[] => [
      {
        id: 'voice.readiness',
        scope,
        basePath: 'voice',
        path: '/readiness',
        method: 'GET',
        authentication: 'owner',
        description: 'Read configured voice readiness.',
        responses: jsonApiResponses(
          Type.Object({
            configured: B,
            transcription: B,
            error: O(S),
            engine: O(S),
            mode: O(S),
            correctionModel: O(S),
          }),
        ),
      },
      ...(['GET', 'PUT', 'DELETE'] as const).map((method): DoomHttpContract => ({
        id: `voice.settings.${method}`,
        scope,
        basePath: 'voice',
        path: '/clients/{clientId}',
        method,
        authentication: 'owner',
        description: 'Read, select or clear the client microphone.',
        ...(method === 'PUT'
          ? {
              body: {
                required: true,
                contentType: 'application/json',
                schema: Type.Object({ deviceId: Type.Union([S, Type.Null()]) }),
              },
            }
          : {}),
        responses: jsonApiResponses(Settings),
      })),
      {
        id: 'voice.inputs',
        scope,
        basePath: 'voice',
        path: '/clients/{clientId}/inputs',
        method: 'PUT',
        authentication: 'owner',
        description: 'Register enumerated microphones before selecting one.',
        body: { required: true, contentType: 'application/json', schema: Type.Object({ inputs: Inputs }) },
        responses: jsonApiResponses(Settings),
      },
    ]),
  ],
  sockets: [
    {
      id: 'voice.control',
      scope: 'session',
      service: voiceControlMethod.service,
      member: voiceControlMethod.method,
      kind: 'method',
      direction: 'client-to-server',
      description: 'Voice session control through the scoped plugin service.',
      input: voiceControlMethod.input,
      output: voiceControlMethod.output,
    },
    ...(['global', 'workspace'] as const).flatMap((scope) => [
      {
        id: 'voice.wake',
        scope,
        service: 'doompi.hub.v1',
        member: 'voice_media_wake',
        kind: 'channel' as const,
        direction: 'server-to-client' as const,
        description: 'Voice media wake channel payload.',
        input: Wake,
      },
      {
        id: 'voice.ownership',
        scope,
        service: 'doompi.hub.v1',
        member: 'voice_ownership',
        kind: 'channel' as const,
        direction: 'server-to-client' as const,
        description: 'Browser media ownership channel payload.',
        input: Type.Object({
          type: Type.Literal('browser-media-session'),
          ...Version,
          activeSessionId: Type.Union([S, Type.Null()]),
        }),
      },
    ]),
  ],
});
export default apiContracts;
