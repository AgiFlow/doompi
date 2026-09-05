import { describe, expect, it } from 'vitest';
import { author, authorChannel } from '../../src/web/authorStore.ts';

const accepted = { kind: 'accepted', generation: 1, ownerToken: 'owner', leaseMs: 1000 };
const request = {
  kind: 'request',
  generation: 1,
  ownerToken: 'owner',
  catalogToken: 'catalog',
  requestId: 'request',
  name: 'tool',
  arguments: {},
};
describe('Author browser channel validation', () => {
  it.each([
    null,
    [],
    'invalid',
    {},
    { activation: 'active', capabilityCount: -1 },
    { activation: 'active', capabilityCount: 1.5 },
    { kind: 'rejected' },
    { kind: 'accepted' },
    { ...accepted, generation: 1.5 },
    { ...accepted, ownerToken: 1 },
    { ...accepted, leaseMs: '1000' },
    { ...accepted, catalogToken: 1 },
    { ...request, catalogToken: 1 },
    { ...request, requestId: 1 },
    { ...request, name: 1 },
    { ...request, arguments: [] },
    { ...request, arguments: null },
    { ...request, kind: 'unknown' },
  ])('ignores malformed hub messages: %j', (input) => expect(authorChannel.parse(input)).toBeNull());
  it.each([
    { activation: 'active', capabilityCount: 1 },
    { activation: 'inactive', capabilityCount: 0 },
    accepted,
    { ...accepted, catalogToken: 'catalog' },
    request,
    { ...request, kind: 'cancel' },
    { kind: 'rejected', reason: 'inactive' },
  ])('preserves valid messages: %j', (input) => expect(authorChannel.parse(input)).toEqual(input));
  it('applies inactive bridge state and drops the session', () => {
    authorChannel.apply('validation', { activation: 'active', capabilityCount: 2 });
    authorChannel.apply('validation', { kind: 'rejected', reason: 'inactive' });
    authorChannel.drop('validation');
    expect(author.select(author.store.state, 'validation')).toEqual({ activation: 'inactive', capabilityCount: 0 });
  });
});
