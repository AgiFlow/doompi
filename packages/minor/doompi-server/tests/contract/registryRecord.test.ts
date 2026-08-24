import type { SessionRecord as WebSessionRecord } from '@agimon-ai/doompi-web';
import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../src/types/registry.ts';

// The record shape is declared in both packages (the writer here, the reader in
// doompi-web) instead of being imported across the optional-peer boundary.
// These identity functions fail `tsc --noEmit` the moment the declarations
// drift apart in either direction.
const toWebRecord = (record: SessionRecord): WebSessionRecord => record;
const toServerRecord = (record: WebSessionRecord): SessionRecord => record;

describe('session record contract', () => {
  it('stays assignable between doompi-server and doompi-web', () => {
    const record: SessionRecord = {
      version: 1,
      id: 'a1b2',
      name: 'untitled',
      cwd: '/workspace/project',
      socketPath: '/run/doompi/a1b2.sock',
      tokenFile: '/run/doompi/a1b2.token',
      pid: 4242,
      createdAt: '2026-08-24T00:00:00.000Z',
    };
    expect(toServerRecord(toWebRecord(record))).toEqual(record);
  });
});
