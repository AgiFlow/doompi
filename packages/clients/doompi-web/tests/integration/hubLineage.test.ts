import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionLineagePath } from '@agimon-ai/doompi-web-contracts';
import { watchRegistry } from '../../src/adapters/registryWatcher.ts';
import { readSessionLineage } from '../../src/adapters/sessionLineage.ts';
import { createSessionHub, type HubEvent, type SessionHub } from '../../src/adapters/sessionHub.ts';
import type { SessionSummary } from '../../src/types/hub.ts';
import { startFakeSession } from '../support/fakeSession.ts';

let cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  cleanups = [];
});

function freshRegistryDir(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-hub-lineage-')), 'run');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  cleanups.push(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
}

function writeSidecar(registryDir: string, sessionId: string, raw: string): void {
  fs.writeFileSync(sessionLineagePath(registryDir, sessionId), raw, 'utf8');
}

interface Harness {
  hub: SessionHub;
  latest(sessionId: string): SessionSummary | undefined;
}

/** Wires the hub exactly as httpServer does: the real sidecar reader over the registry dir. */
function startHub(registryDir: string): Harness {
  const events: HubEvent[] = [];
  const hub = createSessionHub({
    source: watchRegistry(registryDir),
    channels: [],
    readLineage: (sessionId) => readSessionLineage(registryDir, sessionId),
  });
  cleanups.push(() => hub.close());
  hub.onEvent((event) => events.push(event));
  return {
    hub,
    latest(sessionId) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.kind === 'upsert' && event.session.id === sessionId) return event.session;
      }
      return hub.snapshot().find((summary) => summary.id === sessionId);
    },
  };
}

async function startRegisteredSession(registryDir: string, id: string): Promise<void> {
  const session = await startFakeSession({ id, name: id, registryDir });
  cleanups.push(() => session.close());
}

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('the session hub publishing lineage read from the sidecar', () => {
  it('carries the parent and provenance onto the emitted summary', async () => {
    const registryDir = freshRegistryDir();
    writeSidecar(registryDir, 'child', JSON.stringify({ version: 1, parentSessionId: 'root', provenance: 'worktree' }));
    const harness = startHub(registryDir);
    await startRegisteredSession(registryDir, 'child');

    await waitFor(() => harness.latest('child') !== undefined, 'the nested session listed');

    const summary = harness.latest('child');
    expect(summary?.parentSessionId).toBe('root');
    expect(summary?.sessionProvenance).toBe('worktree');
  });

  it('leaves both fields absent when the session has no sidecar', async () => {
    const registryDir = freshRegistryDir();
    const harness = startHub(registryDir);
    await startRegisteredSession(registryDir, 'solo');

    await waitFor(() => harness.latest('solo') !== undefined, 'the top-level session listed');

    const summary = harness.latest('solo');
    expect(summary).toBeDefined();
    expect('parentSessionId' in (summary ?? {})).toBe(false);
    expect('sessionProvenance' in (summary ?? {})).toBe(false);
  });

  it('leaves both fields absent when the sidecar is a torn write', async () => {
    const registryDir = freshRegistryDir();
    writeSidecar(registryDir, 'torn', '{"version":1,"parentSessionId":"ro');
    const harness = startHub(registryDir);
    await startRegisteredSession(registryDir, 'torn');

    await waitFor(() => harness.latest('torn') !== undefined, 'the session listed');

    expect(harness.latest('torn')?.parentSessionId).toBeUndefined();
  });

  it('leaves both fields absent when the sidecar carries an unknown version', async () => {
    const registryDir = freshRegistryDir();
    writeSidecar(
      registryDir,
      'future',
      JSON.stringify({ version: 99, parentSessionId: 'root', provenance: 'worktree' }),
    );
    const harness = startHub(registryDir);
    await startRegisteredSession(registryDir, 'future');

    await waitFor(() => harness.latest('future') !== undefined, 'the session listed');

    expect(harness.latest('future')?.parentSessionId).toBeUndefined();
  });

  it('keeps the lineage it read at spawn even after a later sidecar rewrite', async () => {
    const registryDir = freshRegistryDir();
    writeSidecar(registryDir, 'child', JSON.stringify({ version: 1, parentSessionId: 'root', provenance: 'worktree' }));
    const harness = startHub(registryDir);
    await startRegisteredSession(registryDir, 'child');
    await waitFor(() => harness.latest('child') !== undefined, 'the nested session listed');

    // The hub reads the sidecar once, at startSession: a parent is fixed when a
    // session is spawned, so later edits must not reshuffle the rail.
    writeSidecar(
      registryDir,
      'child',
      JSON.stringify({ version: 1, parentSessionId: 'someone-else', provenance: 'fork' }),
    );

    expect(harness.hub.snapshot().find((summary) => summary.id === 'child')?.parentSessionId).toBe('root');
  });
});
