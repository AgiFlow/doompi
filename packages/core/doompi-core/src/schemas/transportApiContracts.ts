import { PROTOCOL_VERSION } from '@earendil-works/pi-protocol';
import { Type } from 'typebox';

import type { DoomSocketContract } from './apiContracts';
import { DoomPluginCallSchema } from './pluginProtocol';

const S = Type.String({ minLength: 1 });
const Json = Type.Unknown({
  description: 'JSON value; its application shape is defined by the addressed service member.',
});
const E = Type.Object({ code: S, message: Type.String() }, { additionalProperties: false });
const ServerId = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const Address = Type.Object({ key: S, generation: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const Mode = Type.Union([Type.Literal('singleton'), Type.Literal('keyed')]);
const SessionTarget = Type.Object(
  { serverId: ServerId, sessionId: S, attachmentId: S },
  { additionalProperties: false },
);
const Target = Type.Union([Type.Object({ serverId: ServerId }, { additionalProperties: false }), SessionTarget]);
export const ChordCallSchema = Type.Object(
  { serviceId: S, member: S, args: Type.Array(Json), instance: Type.Optional(Address) },
  { additionalProperties: false },
);
const Segment = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);
const Path = Type.Array(Segment);
const PathRef = Type.Union([Path, Type.Integer({ minimum: 0 })]);
const NonemptyPathRef = Type.Union([Type.Array(Segment, { minItems: 1 }), Type.Integer({ minimum: 0 })]);
const Index = Type.Integer({ minimum: 0 });
export const ChordWireOpSchema = Type.Union(
  [
    Type.Tuple([Type.Literal('r'), Json]),
    Type.Tuple([Type.Literal('s'), NonemptyPathRef, Json]),
    Type.Tuple([Type.Literal('s'), Json]),
    Type.Tuple([Type.Literal('d'), NonemptyPathRef]),
    Type.Tuple([Type.Literal('d')]),
    Type.Tuple([Type.Literal('a'), NonemptyPathRef, Type.String()]),
    Type.Tuple([Type.Literal('a'), Type.String()]),
    Type.Tuple([Type.Literal('t'), NonemptyPathRef, Index]),
    Type.Tuple([Type.Literal('t'), Index]),
    Type.Tuple([Type.Literal('p'), PathRef, Index, Index, Type.Array(Json)]),
    Type.Tuple([Type.Literal('p'), Index, Index, Type.Array(Json)]),
    Type.Tuple([Type.Literal('#'), Index, Path]),
  ],
  {
    description:
      'Chord delta tuples. Path dictionary references and omitted paths depend on earlier operations in this subscription; decode with the Chord delta decoder.',
  },
);
const Instance = Type.Object({
  instance: Type.Optional(Address),
  members: Type.Array(
    Type.Union([
      Type.Object({ name: S, kind: Type.Literal('method') }),
      Type.Object({
        name: S,
        kind: Type.Literal('state'),
        sequence: Type.Integer({ minimum: 0 }),
        ops: Type.Array(ChordWireOpSchema),
      }),
    ]),
  ),
});
export const ChordSnapshotSchema = Type.Object({ serviceId: S, mode: Mode, instances: Type.Array(Instance) });
export const ChordUpdateSchema = Type.Union([
  Type.Object({
    type: Type.Literal('state'),
    instance: Type.Optional(Address),
    member: S,
    sequence: Type.Integer({ minimum: 1 }),
    ops: Type.Array(ChordWireOpSchema),
  }),
  Type.Object({ type: Type.Literal('unavailable') }),
  Type.Object({ type: Type.Literal('replaced'), snapshot: Instance }),
  Type.Object({ type: Type.Literal('spawned'), instance: Instance }),
  Type.Object({ type: Type.Literal('closed'), instance: Address }),
]);
export const PiClientMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal('hello'), version: Type.Integer({ minimum: 0 }) }),
  Type.Object({ type: Type.Literal('request'), id: S, target: Target, call: ChordCallSchema }),
  Type.Object({ type: Type.Literal('cancel'), id: S, target: Target }),
]);
export const PiServerMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal('hello'), version: Type.Literal(PROTOCOL_VERSION), serverId: ServerId }),
  Type.Object({ type: Type.Literal('hello_error'), error: E }),
  Type.Object({ type: Type.Literal('response'), id: S, ok: Type.Literal(true), result: Type.Optional(Json) }),
  Type.Object({ type: Type.Literal('response'), id: S, ok: Type.Literal(false), error: E }),
  Type.Object({ type: Type.Literal('service_update'), subscriptionId: S, update: ChordUpdateSchema }),
  Type.Object({ type: Type.Literal('attachment'), attachment: Type.Union([SessionTarget, Type.Null()]) }),
]);
export const transportSocketContracts: DoomSocketContract[] = [
  {
    id: 'pi.client',
    scope: 'global',
    service: '$pi',
    member: 'client',
    direction: 'client-to-server',
    kind: 'channel',
    input: PiClientMessageSchema,
    description: `Pi protocol ${PROTOCOL_VERSION} decoded client envelope. Encode with the public Pi codec and framing functions, then seal for WebSocket delivery.`,
  },
  {
    id: 'pi.server',
    scope: 'global',
    service: '$pi',
    member: 'server',
    direction: 'server-to-client',
    kind: 'channel',
    input: PiServerMessageSchema,
    description: 'Pi decoded server envelope. Responses correlate by id; service updates correlate by subscriptionId.',
  },
  {
    id: 'chord.catalogue',
    scope: 'global',
    service: '$chord.service',
    member: 'catalogue',
    direction: 'client-to-server',
    kind: 'method',
    input: Type.Tuple([]),
    output: Type.Array(Type.Object({ serviceId: S, mode: Mode })),
    errors: E,
    description: 'Discover services at the selected Pi target.',
  },
  {
    id: 'chord.subscribe',
    scope: 'global',
    service: '$chord.service',
    member: 'subscribe',
    direction: 'client-to-server',
    kind: 'method',
    input: Type.Tuple([S, S, Mode]),
    output: ChordSnapshotSchema,
    errors: E,
    description:
      'Subscribe with [subscriptionId, serviceId, mode]; subsequent Pi service_update messages contain Chord deltas.',
  },
  {
    id: 'chord.unsubscribe',
    scope: 'global',
    service: '$chord.service',
    member: 'unsubscribe',
    direction: 'client-to-server',
    kind: 'method',
    input: Type.Tuple([S]),
    errors: E,
    description: 'Unsubscribe by subscriptionId.',
  },
  {
    id: 'plugin.invoke',
    scope: 'global',
    service: 'doompi.plugin.v1',
    member: 'invoke',
    direction: 'client-to-server',
    kind: 'method',
    input: Type.Tuple([DoomPluginCallSchema]),
    output: Json,
    errors: E,
    description: 'Invoke the selected scoped plugin method. Its declaration supplies input and output shapes.',
  },
];
