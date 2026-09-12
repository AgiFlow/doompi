import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServerBundle, resolveServerBundleSource } from '../../src/adapters/serverFacetLoader.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function generation(name = 'current') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-bundle-source-'));
  roots.push(directory);
  const descriptor = { version: 2, generation: name, fingerprint: 'a'.repeat(64), entries: [] };
  const descriptorPath = path.join(directory, 'server.bundle.json');
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
  return {
    directory,
    descriptor,
    descriptorPath,
    registration: {
      apiDirectory: directory,
      generation: name,
      serverBundle: { path: descriptorPath, fingerprint: descriptor.fingerprint },
    },
  };
}

describe('explicit server bundle source admission', () => {
  it('mounts nothing without registration or an override', () => {
    expect(resolveServerBundleSource({})).toEqual({ kind: 'empty' });
  });
  it('keeps new format when its registered directory is supplied as an override', async () => {
    const fixture = generation();
    const source = resolveServerBundleSource({
      registration: fixture.registration,
      directoryOverride: fixture.directory,
    });
    expect(source.kind).toBe('descriptor');
    if (source.kind !== 'descriptor') throw new Error('Expected descriptor source');
    expect((await loadServerBundle('global', { ...source, majorMode: 'code', activeLayers: [] })).facets).toEqual([]);
  });
  it('does not downgrade a missing selected descriptor even through an override', async () => {
    const fixture = generation();
    fs.rmSync(fixture.descriptorPath);
    const source = resolveServerBundleSource({
      registration: fixture.registration,
      directoryOverride: fixture.directory,
    });
    expect(source.kind).toBe('descriptor');
    if (source.kind !== 'descriptor') throw new Error('Expected descriptor source');
    await expect(loadServerBundle('global', { ...source, majorMode: 'code', activeLayers: [] })).rejects.toThrow();
  });
  it('admits an explicitly selected previous generation with its own identity', () => {
    const current = generation();
    const previous = generation('previous');
    expect(
      resolveServerBundleSource({ registration: current.registration, directoryOverride: previous.directory }),
    ).toMatchObject({
      kind: 'descriptor',
      generation: 'previous',
      fingerprint: previous.descriptor.fingerprint,
    });
  });
  it('rejects malformed overrides instead of trying existing legacy modules', () => {
    const fixture = generation();
    fs.writeFileSync(fixture.descriptorPath, '{');
    fs.writeFileSync(path.join(fixture.directory, 'hub.routes.mjs'), 'throw new Error("must not import")');
    expect(() => resolveServerBundleSource({ directoryOverride: fixture.directory })).toThrow();
  });
  it('confines override descriptor symlinks to their admitted directory', () => {
    const outside = generation();
    const fixture = generation();
    fs.rmSync(fixture.descriptorPath);
    fs.symlinkSync(outside.descriptorPath, fixture.descriptorPath);
    expect(() => resolveServerBundleSource({ directoryOverride: fixture.directory })).toThrow(/escapes/);
  });
  it('rejects a selected directory without the canonical descriptor', () => {
    const fixture = generation();
    fs.rmSync(fixture.descriptorPath);
    expect(() => resolveServerBundleSource({ directoryOverride: fixture.directory })).toThrow(/descriptor is missing/u);
    expect(() =>
      resolveServerBundleSource({ registration: { apiDirectory: fixture.directory, generation: 'old' } }),
    ).toThrow(/descriptor is missing/u);
  });
});
