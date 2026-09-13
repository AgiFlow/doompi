import {
  createServiceCatalogueCall,
  createServiceSubscribeCall,
  parseServiceCall,
  parseWireServiceProviderUpdate,
} from '@earendil-works/chord';
import type { JsonValue } from '@earendil-works/chord';
import { encoder, decoder, apply } from '@earendil-works/chord/delta';
import {
  ClientMessageDecoder,
  ServerMessageDecoder,
  encodeClientMessage,
  encodeServerMessage,
  PROTOCOL_VERSION,
} from '@earendil-works/pi-protocol';
import type { TSchema } from 'typebox';
import { Check } from 'typebox/value';
import { expect, it } from 'vitest';

import { builtinApiContract } from '../../../src/schemas/builtinApiContracts';
import { createApiDocuments, canonicalContractJson } from '../../../src/services/apiContracts';

const documents = createApiDocuments([
  {
    scope: 'global',
    majorMode: 'test',
    activeLayers: [],
    compiled: {
      version: 1,
      generation: 'test',
      fingerprint: 'a'.repeat(64),
      packages: [
        {
          packageName: 'test',
          packageVersion: 'test',
          scopes: ['global'],
          owners: [{ majorMode: 'test', layer: 'default' }],
          contract: builtinApiContract,
        },
      ],
    },
  },
]);
const exported = JSON.parse(canonicalContractJson(documents.asyncapi)) as {
  components: { schemas: Record<string, { schema: TSchema }> };
};
const accepts = (name: string, value: unknown) =>
  Check(exported.components.schemas[`test.global.${name}.input`]!.schema, value);

it('validates real Pi codec frames and Chord calls against the serialized AsyncAPI schemas', () => {
  expect(documents.manifest.protocols.pi).toBe(String(PROTOCOL_VERSION));
  const call = createServiceSubscribeCall('subscription', 'doompi.session.v1', 'singleton');
  expect(parseServiceCall(call)).toEqual(call);
  const bytes = encodeClientMessage({
    type: 'request',
    id: 'request',
    target: { serverId: '12345678-1234-4123-8123-123456789abc' },
    call: JSON.parse(JSON.stringify(call)) as JsonValue,
  });
  const client = new ClientMessageDecoder();
  expect(client.push(bytes.slice(0, 3))).toEqual([]);
  const [message] = client.push(bytes.slice(3));
  client.end();
  expect(accepts('pi.client', message)).toBe(true);
  expect(accepts('pi.client', { ...message, id: 42 })).toBe(false);
  expect(accepts('pi.client', { type: 'request', id: 'r', target: {}, call })).toBe(false);
  expect(
    accepts('pi.client', {
      type: 'request',
      id: 'r',
      target: { serverId: '12345678-1234-4123-8123-123456789abc' },
      call: createServiceCatalogueCall(),
    }),
  ).toBe(true);
});

it('validates Chord state deltas carried through the real Pi codec', () => {
  const ops = encoder().encode([
    ['r', { events: [] }],
    ['p', ['events'], 0, 0, [{ sequence: 1, frame: { type: 'session_removed', sessionId: 's' } }]],
  ]);
  const update = { type: 'state' as const, member: 'state', sequence: 1, ops };
  expect(parseWireServiceProviderUpdate(update)).toEqual(update);
  const bytes = encodeServerMessage({
    type: 'service_update',
    subscriptionId: 'subscription',
    update: JSON.parse(JSON.stringify(update)) as JsonValue,
  });
  const server = new ServerMessageDecoder();
  const [message] = server.push(bytes);
  server.end();
  expect(accepts('pi.server', message)).toBe(true);
  expect(apply(undefined, decoder().decode(ops))).toEqual({
    events: [{ sequence: 1, frame: { type: 'session_removed', sessionId: 's' } }],
  });
  expect(
    accepts('pi.server', {
      type: 'service_update',
      subscriptionId: 'subscription',
      update: { ...update, ops: [['s']] },
    }),
  ).toBe(false);
  expect(accepts('pi.server', { type: 'response', id: 'r', ok: false, error: { code: 42, message: 'bad' } })).toBe(
    false,
  );
});
