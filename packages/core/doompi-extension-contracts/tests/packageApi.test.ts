import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  doomApiCallerFrom,
  DOOM_API_CALLER_DEVICE_ID_HEADER,
  DOOM_API_CALLER_LOCALITY_HEADER,
  DOOM_API_CALLER_STEP_UP_HEADER,
} from '../src/schemas/packageApi.ts';

describe('owned HTTP package authoring', () => {
  it('uses server facets without doompiApi manifest declarations', () => {
    const repositoryRoot = new URL('../../../../', import.meta.url);
    const packages = [
      'packages/core/doompi',
      ...['file-edit', 'log', 'mcp', 'prompt', 'runner'].map((name) => `packages/default/doompi-${name}`),
      ...['author', 'computer-use', 'plan', 'voice', 'workflow'].map((name) => `packages/minor/doompi-${name}`),
      'layers/source-control/doompi-git',
      'layers/team/doompi-team',
    ];
    for (const directory of packages) {
      const manifest = JSON.parse(fs.readFileSync(new URL(`${directory}/package.json`, repositoryRoot), 'utf8'));
      expect(manifest.doompiApi, directory).toBeUndefined();
      expect(manifest.doompiServer, directory).toMatchObject({
        entry: './src/exports/extensions/server.ts',
        dist: './dist/extensions/server.mjs',
      });
    }
  });
});

describe('trusted package API caller headers', () => {
  const caller = (locality?: string, deviceId?: string, stepUp?: string) => {
    const headers = new Headers();
    if (locality !== undefined) headers.set(DOOM_API_CALLER_LOCALITY_HEADER, locality);
    if (deviceId !== undefined) headers.set(DOOM_API_CALLER_DEVICE_ID_HEADER, deviceId);
    if (stepUp !== undefined) headers.set(DOOM_API_CALLER_STEP_UP_HEADER, stepUp);
    return doomApiCallerFrom(headers);
  };

  it('parses every complete caller stamp', () => {
    expect(caller('local', undefined, 'not-required')).toEqual({ locality: 'local', stepUp: 'not-required' });
    for (const stepUp of ['not-required', 'verified', 'unavailable']) {
      expect(caller('remote', 'phone-1', stepUp)).toEqual({ locality: 'remote', deviceId: 'phone-1', stepUp });
    }
  });

  it('rejects partial, contradictory, and unknown stamps', () => {
    for (const stamp of [
      [] as string[],
      ['unknown'],
      ['local'],
      ['local', 'spoofed', 'not-required'],
      ['local', undefined, 'verified'],
      ['remote'],
      ['remote', ''],
      ['remote', 'phone-1'],
      ['remote', 'phone-1', 'unknown'],
    ]) {
      expect(caller(stamp[0], stamp[1], stamp[2])).toBeUndefined();
    }
  });
});
