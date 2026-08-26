import { describe, expect, it } from 'vitest';
import {
  DOOM_RELAUNCH_FILE_ENV,
  parseRelaunchHandoff,
  serializeRelaunchHandoff,
} from '../src/exports/relaunchHandoff.ts';

const HANDOFF = { version: 1, majorMode: 'minimal', operationId: 'op-1' } as const;

describe('relaunch handoff', () => {
  it('round-trips through serialize and parse', () => {
    expect(parseRelaunchHandoff(serializeRelaunchHandoff(HANDOFF))).toEqual(HANDOFF);
  });

  it('rejects malformed text, wrong versions, and extra fields', () => {
    expect(parseRelaunchHandoff('not json')).toBeUndefined();
    expect(parseRelaunchHandoff('{"version":2,"majorMode":"a","operationId":"b"}')).toBeUndefined();
    expect(parseRelaunchHandoff('{"version":1,"majorMode":"","operationId":"b"}')).toBeUndefined();
    expect(parseRelaunchHandoff('{"version":1,"majorMode":"a","operationId":"b","extra":1}')).toBeUndefined();
  });

  it('names the environment variable in the DOOMPI family', () => {
    expect(DOOM_RELAUNCH_FILE_ENV).toBe('DOOMPI_RELAUNCH_FILE');
  });
});
