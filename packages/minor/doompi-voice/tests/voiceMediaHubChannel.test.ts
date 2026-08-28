import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HubChannelHost } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceMediaWakeChannel } from '../src/adapters/voiceMediaHubChannel.ts';
import {
  createVoiceMediaWakePublisher,
  parseVoiceMediaWake,
  voiceMediaWakePath,
  watchVoiceMediaWake,
} from '../src/adapters/voiceMediaWakeFile.ts';
import type { VoiceMediaWake } from '../src/types/clientMedia.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-voice-wake-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('voice media wake snapshots', () => {
  it('writes private atomic snapshots to an opaque stable session path', () => {
    const directory = temporaryDirectory();
    const sessionId = 'secret/session-id';
    const publisher = createVoiceMediaWakePublisher(sessionId, { directory });
    publisher.publish({ eventEpoch: 'epoch-a', sequence: 7 });

    const target = voiceMediaWakePath(sessionId, { directory });
    expect(path.basename(target)).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(target).not.toContain('secret');
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ eventEpoch: 'epoch-a', sequence: 7 });
    expect(fs.readdirSync(directory)).toEqual([path.basename(target)]);
  });

  it('rejects malformed or expanded wake payloads', () => {
    expect(parseVoiceMediaWake({ eventEpoch: 'epoch', sequence: 0 })).toEqual({ eventEpoch: 'epoch', sequence: 0 });
    for (const invalid of [
      null,
      [],
      'wake',
      { eventEpoch: 'epoch', sequence: 0, sessionId: 'secret' },
      { eventEpoch: '', sequence: 0 },
      { eventEpoch: 'x'.repeat(201), sequence: 0 },
      { eventEpoch: 'epoch', sequence: -1 },
      { eventEpoch: 'epoch', sequence: 1.5 },
      { eventEpoch: 'epoch', sequence: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(parseVoiceMediaWake(invalid)).toBeUndefined();
    }
  });

  it('watches the stable path across broker replacement and stops cleanly', async () => {
    const directory = temporaryDirectory();
    const publisher = createVoiceMediaWakePublisher('session-a', { directory });
    publisher.publish({ eventEpoch: 'epoch-before', sequence: 3 });
    const received: Array<VoiceMediaWake | undefined> = [];
    const source = watchVoiceMediaWake('session-a', (wake) => received.push(wake), {
      directory,
      debounceMs: 5,
      pollMs: 20,
    });
    cleanups.push(() => source.close());

    await waitFor(() => received.some((wake) => wake?.eventEpoch === 'epoch-before'), 'initial wake');
    publisher.publish({ eventEpoch: 'epoch-after', sequence: 0 });
    await waitFor(() => received.some((wake) => wake?.eventEpoch === 'epoch-after'), 'replacement wake');
    source.close();
    const count = received.length;
    publisher.publish({ eventEpoch: 'epoch-final', sequence: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(count);
  });
});

describe('voice media wake hub channel', () => {
  it('publishes and snapshots wake markers while disposing replaced and removed sources', () => {
    const callbacks = new Map<string, (wake: VoiceMediaWake | undefined) => void>();
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const watch = vi.fn((sessionId: string, onWake: (wake: VoiceMediaWake | undefined) => void) => {
      callbacks.set(sessionId, onWake);
      const close = vi.fn();
      closes.push(close);
      return { close };
    });
    const published: Array<{ sessionId: string; payload: unknown }> = [];
    const host: HubChannelHost = {
      sessions: () => [],
      publish: (sessionId, payload) => published.push({ sessionId, payload }),
      onNotice: () => undefined,
    };
    const channel = createVoiceMediaWakeChannel(watch);
    const source = channel.start(host);

    expect(channel.frameType).toBe('voice_media_wake');
    source.sessionAdded?.({ sessionId: 'session-a', cwd: '/repo' });
    callbacks.get('session-a')?.({ eventEpoch: 'epoch-a', sequence: 2 });
    expect(source.payloadFor({ sessionId: 'session-a', cwd: '/repo' })).toEqual({
      eventEpoch: 'epoch-a',
      sequence: 2,
    });
    expect(published).toEqual([{ sessionId: 'session-a', payload: { eventEpoch: 'epoch-a', sequence: 2 } }]);

    source.sessionAdded?.({ sessionId: 'session-a', cwd: '/repo' });
    expect(closes[0]).toHaveBeenCalledOnce();
    callbacks.get('session-a')?.({ eventEpoch: 'epoch-b', sequence: 0 });
    callbacks.get('session-a')?.(undefined);
    expect(source.payloadFor({ sessionId: 'session-a', cwd: '/repo' })).toBeUndefined();
    callbacks.get('session-a')?.({ eventEpoch: 'epoch-b', sequence: 1 });
    source.sessionRemoved?.('session-a');
    expect(closes[1]).toHaveBeenCalledOnce();
    expect(source.payloadFor({ sessionId: 'session-a', cwd: '/repo' })).toBeUndefined();
    source.sessionAdded?.({ sessionId: 'session-b', cwd: '/repo' });
    source.close();
    expect(closes[2]).toHaveBeenCalledOnce();
  });
});
