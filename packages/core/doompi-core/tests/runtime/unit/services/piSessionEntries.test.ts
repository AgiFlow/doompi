import type { Entry } from '@earendil-works/pi-agent-core';
import type { CustomEntry, SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import { CURRENT_SESSION_VERSION } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import {
  fromPiSessionEntry,
  PI_MIRRORED_ENTRY_PREFIX,
  toPiFileEntries,
  toPiSessionEntry,
  toPiSessionHeader,
} from '../../../../src/services/piSessionEntries';

const CREATED_AT = 1_700_000_000_000;
const CREATED_AT_ISO = '2023-11-14T22:13:20.000Z';

const messageEntry: Entry = {
  type: 'message',
  id: 'entry-2',
  parentId: 'entry-1',
  seq: 2,
  timestamp: CREATED_AT,
  message: { role: 'user', content: 'hello', timestamp: CREATED_AT },
};

describe('harness to Pi session entry conversion', () => {
  it('carries a message entry across with its identity and message intact', () => {
    const converted = toPiSessionEntry(messageEntry) as SessionMessageEntry;

    expect(converted.type).toBe('message');
    expect(converted.id).toBe('entry-2');
    expect(converted.parentId).toBe('entry-1');
    expect(converted.message).toEqual({ role: 'user', content: 'hello', timestamp: CREATED_AT });
    expect(converted).not.toHaveProperty('seq');
  });

  it('converts epoch milliseconds to the exact ISO timestamp', () => {
    const converted = toPiSessionEntry({ ...messageEntry, timestamp: CREATED_AT + 123 });

    expect(converted?.timestamp).toBe('2023-11-14T22:13:20.123Z');
  });

  it('skips a harness entry type it cannot map instead of throwing', () => {
    const unknownEntry = {
      type: 'future_harness_type',
      id: 'entry-3',
      parentId: 'entry-2',
      seq: 3,
      timestamp: CREATED_AT,
    } as unknown as Entry;

    expect(() => toPiSessionEntry(unknownEntry)).not.toThrow();
    expect(toPiSessionEntry(unknownEntry)).toBeUndefined();

    const files = toPiFileEntries({ id: 'session-1', cwd: '/repo', createdAt: CREATED_AT }, [
      messageEntry,
      unknownEntry,
    ]);

    expect(files).toHaveLength(2);
    expect(files[1]).toMatchObject({ type: 'message', id: 'entry-2' });
  });

  it('synthesizes a header without a parent session', () => {
    const header = toPiSessionHeader({ id: 'session-1', cwd: '/repo', createdAt: CREATED_AT });

    expect(header).toEqual({
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: 'session-1',
      timestamp: CREATED_AT_ISO,
      cwd: '/repo',
    });
    expect(header).not.toHaveProperty('parentSession');
  });

  it('synthesizes a header with a parent session', () => {
    const header = toPiSessionHeader({
      id: 'session-1',
      cwd: '/repo',
      createdAt: CREATED_AT,
      parentSessionId: 'session-0',
    });

    expect(header.parentSession).toBe('session-0');
  });
});

describe('Pi to harness session entry mirroring', () => {
  it('mirrors a Pi custom entry under its own custom type', () => {
    const custom: CustomEntry = {
      type: 'custom',
      id: 'pi-1',
      parentId: null,
      timestamp: CREATED_AT_ISO,
      customType: 'acme.state',
      data: { open: true },
    };

    expect(fromPiSessionEntry(custom)).toEqual({ customType: 'acme.state', data: { open: true } });
  });

  it('mirrors a Pi label entry under the reserved prefix, preserving the whole record', () => {
    const label: SessionEntry = {
      type: 'label',
      id: 'pi-2',
      parentId: 'pi-1',
      timestamp: CREATED_AT_ISO,
      targetId: 'pi-1',
      label: 'checkpoint',
    };

    expect(fromPiSessionEntry(label)).toEqual({
      customType: `${PI_MIRRORED_ENTRY_PREFIX}label`,
      data: label,
    });
  });

  it('does not mirror a Pi message entry, which the agent loop already records', () => {
    const message: SessionMessageEntry = {
      type: 'message',
      id: 'pi-3',
      parentId: 'pi-2',
      timestamp: CREATED_AT_ISO,
      message: { role: 'user', content: 'hello', timestamp: CREATED_AT },
    };

    expect(fromPiSessionEntry(message)).toBeUndefined();
  });
});
