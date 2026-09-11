import { generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFederationStore } from '../../src/adapters/federationStore.ts';
import { federationIdentity, parseFederationPeer } from '../../src/services/federationPolicy.ts';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-federation-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function peer() {
  const keys = generateKeyPairSync('ed25519');
  return {
    ...federationIdentity(randomUUID(), keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')),
    name: 'Peer',
    origin: 'https://peer.example',
    agentIds: ['s1'],
  };
}

it('persists a private identity without exporting the signing key', () => {
  const store = createFederationStore(directory);
  const identity = store.identity();
  expect(createFederationStore(directory).identity()).toEqual(identity);
  expect(Object.keys(identity).sort()).toEqual(['fingerprint', 'hubId', 'publicKey']);
  expect(fs.statSync(path.join(directory, 'federation.json')).mode & 0o077).toBe(0);
  expect(fs.statSync(directory).mode & 0o077).toBe(0);
});

it('requires confirmation for replacement, and observes grants and revocation across instances', () => {
  const first = createFederationStore(directory);
  const second = createFederationStore(directory);
  const enrolled = peer();
  first.enroll(enrolled);
  expect(second.peers()).toEqual([enrolled]);
  expect(() => second.enroll({ ...enrolled, agentIds: [] })).toThrow('confirm');
  second.enroll({ ...enrolled, agentIds: [] }, enrolled.fingerprint);
  expect(first.peers()[0]?.agentIds).toEqual([]);
  const replacement = { ...peer(), hubId: enrolled.hubId };
  first.enroll(replacement, enrolled.fingerprint);
  expect(second.peers()).toEqual([replacement]);
  expect(first.revoke(enrolled.hubId)).toBe(true);
  expect(second.peers()).toEqual([]);
  expect(second.revoke(enrolled.hubId)).toBe(false);
});

it('rejects self enrollment and reused keys under different identities', () => {
  const store = createFederationStore(directory);
  expect(() => store.enroll({ ...peer(), ...store.identity() })).toThrow('itself');
  const enrolled = peer();
  store.enroll(enrolled);
  expect(() => store.enroll({ ...enrolled, hubId: randomUUID() })).toThrow('already enrolled');
});

it.each([
  { origin: 'http://remote.example' },
  { origin: 'https://user:password@peer.example' },
  { origin: 'https://peer.example/path' },
  { origin: 'https://peer.example/?token=secret' },
  { agentIds: ['*'] },
  { agentIds: ['s1', 's1'] },
  { agentIds: ['../s1'] },
  { fingerprint: '0'.repeat(64) },
  { publicKey: 'invalid' },
  { name: '\n' },
])('rejects malformed or overbroad enrollment %j', (invalid) => {
  expect(() => parseFederationPeer({ ...peer(), ...invalid })).toThrow();
});

it('keeps malformed state byte-exact and never silently creates a new identity', () => {
  const file = path.join(directory, 'federation.json');
  fs.writeFileSync(file, '{broken');
  expect(() => createFederationStore(directory).identity()).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
});

it('refuses an ambiguous lock instead of reclaiming it', () => {
  fs.writeFileSync(path.join(directory, 'federation.json.lock'), 'existing writer');
  expect(() => createFederationStore(directory).identity()).toThrow('confirm no writer');
  expect(fs.readFileSync(path.join(directory, 'federation.json.lock'), 'utf8')).toBe('existing writer');
});

it('does not report revocation success when publication fails', () => {
  const store = createFederationStore(directory);
  const enrolled = peer();
  store.enroll(enrolled);
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('disk unavailable');
  });
  expect(() => store.revoke(enrolled.hubId)).toThrow('disk unavailable');
  expect(store.peers()).toEqual([enrolled]);
});
