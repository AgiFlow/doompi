import { describe, expect, it } from 'vitest';
import { createFrameRing } from '../../src/services/frameRing.ts';
import {
  isRecordFileName,
  parseSessionRecord,
  resolveRegistryDir,
  sessionRecordPath,
} from '../../src/services/registryStore.ts';
import {
  initialPresence,
  presenceAfterCommand,
  presenceAfterRestoredEntry,
  reducePresence,
} from '../../src/services/sessionPresence.ts';

const T0 = '2026-08-24T10:00:00.000Z';
const T1 = '2026-08-24T10:01:00.000Z';
const T2 = '2026-08-24T10:02:00.000Z';

function validRecord(): Record<string, unknown> {
  return {
    version: 1,
    id: 'a1b2',
    name: 'untitled',
    cwd: '/workspace/project',
    socketPath: '/run/a1b2.sock',
    tokenFile: '/run/a1b2.token',
    pid: 4242,
    createdAt: T0,
  };
}

describe('registryStore', () => {
  it('resolves the registry directory with flag over env over home', () => {
    expect(resolveRegistryDir({ flagValue: '/f', envValue: '/e', homeDir: '/h' })).toBe('/f');
    expect(resolveRegistryDir({ envValue: '/e', homeDir: '/h' })).toBe('/e');
    expect(resolveRegistryDir({ homeDir: '/h' })).toBe('/h/.doompi/run');
    expect(sessionRecordPath('/h/.doompi/run', 'a1b2')).toBe('/h/.doompi/run/sessions/a1b2.json');
  });

  it('parses a well-formed record', () => {
    expect(parseSessionRecord(JSON.stringify(validRecord()))).toEqual(validRecord());
  });

  it('rejects records it cannot trust', () => {
    expect(parseSessionRecord('not json')).toBeUndefined();
    expect(parseSessionRecord('[1]')).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...validRecord(), version: 2 }))).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...validRecord(), id: '' }))).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...validRecord(), pid: 'soon' }))).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...validRecord(), socketPath: undefined }))).toBeUndefined();
  });

  it('only considers record files', () => {
    expect(isRecordFileName('a1b2.json')).toBe(true);
    expect(isRecordFileName('a1b2.json.tmp')).toBe(false);
    expect(isRecordFileName('.DS_Store')).toBe(false);
  });
});

describe('frameRing', () => {
  it('keeps the newest frames and counts the loss', () => {
    const ring = createFrameRing(2);
    ring.record({ index: 1 });
    ring.record({ index: 2 });
    ring.record({ index: 3 });
    expect(ring.snapshot()).toEqual({ frames: [{ index: 2 }, { index: 3 }], dropped: 1 });
  });

  it('snapshots a copy, not the live buffer', () => {
    const ring = createFrameRing(8);
    ring.record({ index: 1 });
    const first = ring.snapshot();
    ring.record({ index: 2 });
    expect(first.frames).toHaveLength(1);
  });
});

describe('sessionPresence', () => {
  it('walks a run through turn and back to idle', () => {
    let presence = initialPresence(T0);
    presence = reducePresence(presence, { type: 'agent_start' }, T1);
    expect(presence).toMatchObject({ phase: 'turn', phaseSince: T1 });

    presence = reducePresence(presence, { type: 'agent_settled' }, T2);
    expect(presence).toMatchObject({ phase: 'idle', phaseSince: T2, lastSettledAt: T2, awaitingInput: false });
  });

  it('returns the same object when a frame changes nothing it reports', () => {
    const presence = initialPresence(T0);
    expect(reducePresence(presence, { type: 'message_update' }, T1)).toBe(presence);
    expect(reducePresence(presence, { type: 'agent_settled_elsewhere' }, T1)).toBe(presence);
  });

  it('unwraps replayed frames', () => {
    const presence = reducePresence(initialPresence(T0), { type: 'replay', frame: { type: 'agent_start' } }, T1);
    expect(presence.phase).toBe('turn');
  });

  it('flags a dialog as waiting for input until it is answered', () => {
    let presence = reducePresence(initialPresence(T0), { type: 'agent_start' }, T0);
    presence = reducePresence(presence, { type: 'extension_ui_request', method: 'confirm', id: 'r1' }, T1);
    expect(presence.awaitingInput).toBe(true);

    presence = presenceAfterCommand(presence, { type: 'extension_ui_response', id: 'r1', confirmed: true }, T2);
    expect(presence.awaitingInput).toBe(false);
  });

  it('ignores non-dialog ui requests', () => {
    const presence = initialPresence(T0);
    expect(reducePresence(presence, { type: 'extension_ui_request', method: 'setStatus' }, T1)).toBe(presence);
  });

  it('marks a session as prompted by the outbound command', () => {
    let presence = initialPresence(T0);
    presence = presenceAfterCommand(presence, { type: 'prompt', message: 'go' }, T1);
    expect(presence.everPrompted).toBe(true);
    // Idempotent: a second prompt changes nothing.
    expect(presenceAfterCommand(presence, { type: 'prompt', message: 'more' }, T2)).toBe(presence);
  });

  it('folds the get_state snapshot the hub requests on attach', () => {
    const presence = reducePresence(
      initialPresence(T0),
      {
        type: 'response',
        command: 'get_state',
        data: { isStreaming: true, isCompacting: false, pendingMessageCount: 2, sessionName: 'doompi-web' },
      },
      T1,
    );
    expect(presence).toMatchObject({ phase: 'turn', pendingMessageCount: 2, sessionName: 'doompi-web' });

    const compacting = reducePresence(
      initialPresence(T0),
      { type: 'response', command: 'get_state', data: { isCompacting: true } },
      T1,
    );
    expect(compacting.phase).toBe('compaction');
  });
});

describe('presence restored from the journal', () => {
  const now = '2026-08-25T10:00:00.000Z';
  const userEntry = { type: 'message', id: 'e1', message: { role: 'user', content: [] } };

  it('treats a journalled user message as proof the session was prompted before', () => {
    const fresh = initialPresence(now);
    expect(fresh.everPrompted).toBe(false);

    const restored = presenceAfterRestoredEntry(fresh, userEntry, now);
    expect(restored.everPrompted).toBe(true);
    expect(restored.updatedAt).toBe(now);
  });

  it('ignores entries that prove nothing, and never churns a settled flag', () => {
    const fresh = initialPresence(now);
    for (const entry of [
      { type: 'message', id: 'e1', message: { role: 'assistant', content: [] } },
      { type: 'message', id: 'e2', message: { role: 'toolResult', content: [] } },
      { type: 'custom', id: 'e3', customType: 'doom-minor-modes' },
      { type: 'message', id: 'e4' },
    ]) {
      expect(presenceAfterRestoredEntry(fresh, entry, now)).toBe(fresh);
    }

    const prompted = presenceAfterRestoredEntry(fresh, userEntry, now);
    // Already true: the same object comes back rather than a new summary push.
    expect(presenceAfterRestoredEntry(prompted, userEntry, '2026-08-25T11:00:00.000Z')).toBe(prompted);
  });
});
