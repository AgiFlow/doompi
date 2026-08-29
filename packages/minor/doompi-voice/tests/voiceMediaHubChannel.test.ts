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

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
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
      requestSessionApi: () => Promise.resolve(new Response(null, { status: 501 })),
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

describe('voice ownership hub transport', () => {
  it('polls strict registrations and drains a source transfer request through guarded commands', async () => {
    const commands: Array<{
      sessionId: string;
      command: {
        epoch: string;
        generation: number;
        revision: number;
        phase: string;
        catalog?: { targets: Array<{ handle: string }> };
      };
    }> = [];
    const browserActions: string[] = [];
    const scopes = new Map([
      ['source', { sessionId: 'source', cwd: '/source' }],
      ['target', { sessionId: 'target', cwd: '/target' }],
    ]);
    const channel = createVoiceMediaWakeChannel(() => ({ close: () => undefined }));
    const host: HubChannelHost = {
      sessions: () => [...scopes.values()],
      publish: () => undefined,
      publishToConnection: (connectionId, sessionId, payload) => {
        const command = payload as {
          type?: string;
          version: number;
          generation: number;
          revision: number;
          action: string;
        };
        if (connectionId !== 'opaque-browser' || command.type !== 'browser-media-command') return false;
        browserActions.push(`${sessionId}:${command.action}`);
        queueMicrotask(() =>
          channel.receive?.(
            scopes.get(sessionId)!,
            {
              ...command,
              type: 'browser-media-ack',
              ok: true,
              ...(command.action === 'ready' ? { listening: true } : {}),
            },
            { connectionId },
          ),
        );
        return true;
      },
      onNotice: () => undefined,
      requestSessionApi: async (scope, request) => {
        if (request.method === 'GET') {
          return Response.json({
            registration: {
              version: 1,
              leaseId: `lease-${scope.sessionId}`,
              revision: 1,
              label: scope.sessionId === 'source' ? 'Source' : 'Target',
              eligible: true,
              active: scope.sessionId === 'source',
              requiresBrowserBind: true,
            },
            view: { version: 1, generation: 0, revision: 0, owner: false, transaction: false, targets: [] },
          });
        }
        const command = JSON.parse(String(request.body)) as (typeof commands)[number]['command'];
        commands.push({ sessionId: scope.sessionId, command });
        return Response.json({
          version: 1,
          epoch: command.epoch,
          generation: command.generation,
          revision: command.revision,
          phase: command.phase,
          ok: true,
          ...(command.phase === 'activate' || command.phase === 'resume' ? { listening: true } : {}),
        });
      },
    };
    const source = channel.start(host);
    source.sessionAdded?.(scopes.get('source')!);
    source.sessionAdded?.(scopes.get('target')!);
    channel.receive?.(
      scopes.get('source')!,
      { type: 'browser-media-runtime', version: 1 },
      { connectionId: 'opaque-browser' },
    );
    await waitFor(
      () => commands.some((entry) => entry.sessionId === 'source' && (entry.command.catalog?.targets.length ?? 0) > 0),
      'ownership catalog',
    );
    const catalog = commands.find(
      (entry) => entry.sessionId === 'source' && (entry.command.catalog?.targets.length ?? 0) > 0,
    )?.command.catalog;
    const handle = catalog?.targets[0]?.handle;
    if (!handle) throw new Error('target handle unavailable');
    channel.receive?.(
      scopes.get('source')!,
      { version: 1, requestId: 'request-1', handle },
      { connectionId: 'opaque-browser' },
    );
    await waitFor(() => commands.some((entry) => entry.command.phase === 'commit'), 'ownership commit');
    expect(commands.map((entry) => entry.command.phase)).toEqual(
      expect.arrayContaining(['prepare', 'quiesce', 'activate', 'commit']),
    );
    expect(browserActions).toEqual(['source:detach', 'target:attach', 'target:ready']);
    source.sessionRemoved?.('target');
    source.close();
  });

  it('does not replay an older rejected request after a newer request and target reconnect', async () => {
    const scopes = new Map([
      ['source', { sessionId: 'source', cwd: '/source' }],
      ['target', { sessionId: 'target', cwd: '/target' }],
    ]);
    const commands: Array<{
      sessionId: string;
      command: {
        epoch: string;
        generation: number;
        revision: number;
        phase: string;
        catalog?: { targets: Array<{ handle: string }> };
      };
    }> = [];
    let request: { version: 1; requestId: string; handle: string } | undefined;
    let sourcePolls = 0;
    const host: HubChannelHost = {
      sessions: () => [...scopes.values()],
      publish: () => undefined,
      onNotice: () => undefined,
      requestSessionApi: async (scope, apiRequest) => {
        if (apiRequest.method === 'GET') {
          if (scope.sessionId === 'source') sourcePolls += 1;
          return Response.json({
            registration: {
              version: 1,
              leaseId: `lease-${scope.sessionId}`,
              revision: 1,
              label: scope.sessionId,
              eligible: true,
              active: scope.sessionId === 'source',
              requiresBrowserBind: false,
            },
            ...(scope.sessionId === 'source' && request !== undefined ? { request } : {}),
          });
        }
        const command = JSON.parse(String(apiRequest.body)) as (typeof commands)[number]['command'];
        commands.push({ sessionId: scope.sessionId, command });
        return Response.json({
          version: 1,
          epoch: command.epoch,
          generation: command.generation,
          revision: command.revision,
          phase: command.phase,
          ok: true,
          ...(command.phase === 'activate' || command.phase === 'resume' ? { listening: true } : {}),
        });
      },
    };
    const channel = createVoiceMediaWakeChannel(() => ({ close: () => undefined }));
    const runtimeSource = channel.start(host);
    runtimeSource.sessionAdded?.(scopes.get('source')!);
    runtimeSource.sessionAdded?.(scopes.get('target')!);
    await waitFor(
      () => commands.some((entry) => entry.sessionId === 'source' && (entry.command.catalog?.targets.length ?? 0) > 0),
      'initial ownership catalog',
    );
    const handle = commands.find(
      (entry) => entry.sessionId === 'source' && (entry.command.catalog?.targets.length ?? 0) > 0,
    )?.command.catalog?.targets[0]?.handle;
    if (handle === undefined) throw new Error('Expected an ownership target handle.');

    runtimeSource.sessionRemoved?.('target');
    request = { version: 1, requestId: 'request-once', handle };
    const rejectedPoll = sourcePolls + 1;
    runtimeSource.sessionAdded?.(scopes.get('source')!);
    await waitFor(() => sourcePolls >= rejectedPoll, 'rejected request poll');
    await flushMicrotasks();
    expect(commands.some((entry) => entry.command.phase === 'quiesce')).toBe(false);

    request = { version: 1, requestId: 'request-newer', handle };
    const newerPoll = sourcePolls + 1;
    runtimeSource.sessionAdded?.(scopes.get('source')!);
    await waitFor(() => sourcePolls >= newerPoll, 'newer request poll');
    await flushMicrotasks();
    expect(commands.some((entry) => entry.command.phase === 'quiesce')).toBe(false);

    request = { version: 1, requestId: 'request-once', handle };
    runtimeSource.sessionAdded?.(scopes.get('target')!);
    await flushMicrotasks();
    const reconnectPoll = sourcePolls + 1;
    runtimeSource.sessionAdded?.(scopes.get('source')!);
    await waitFor(() => sourcePolls >= reconnectPoll, 'reconnect request poll');
    await flushMicrotasks();
    expect(commands.some((entry) => entry.command.phase === 'quiesce')).toBe(false);
    runtimeSource.close();
  });

  it.each(['detach', 'attach', 'ready'] as const)(
    'times out a missing %s acknowledgement, rolls back, ignores its late acknowledgement, and transfers again',
    async (droppedAction) => {
      vi.useFakeTimers();
      const scopes = new Map([
        ['source', { sessionId: 'source', cwd: '/source' }],
        ['target', { sessionId: 'target', cwd: '/target' }],
      ]);
      const commands: Array<{
        sessionId: string;
        command: {
          epoch: string;
          generation: number;
          revision: number;
          phase: string;
          catalog?: { owner: boolean; transaction: boolean; targets: Array<{ handle: string }> };
        };
      }> = [];
      const notices: string[] = [];
      let dropped:
        | {
            sessionId: string;
            command: { epoch: string; generation: number; revision: number; action: 'detach' | 'attach' | 'ready' };
          }
        | undefined;
      const channel = createVoiceMediaWakeChannel(() => ({ close: () => undefined }), {
        browserAcknowledgementTimeoutMs: 25,
      });
      const host: HubChannelHost = {
        sessions: () => [...scopes.values()],
        publish: () => undefined,
        publishToConnection: (connectionId, sessionId, payload) => {
          const command = payload as {
            type?: string;
            epoch: string;
            generation: number;
            revision: number;
            action: 'detach' | 'attach' | 'ready';
          };
          if (connectionId !== 'browser' || command.type !== 'browser-media-command') return false;
          if (command.action === droppedAction && dropped === undefined) {
            dropped = { sessionId, command };
            return true;
          }
          queueMicrotask(() =>
            channel.receive?.(
              scopes.get(sessionId)!,
              {
                ...command,
                type: 'browser-media-ack',
                version: 1,
                ok: true,
                ...(command.action === 'ready' ? { listening: true } : {}),
              },
              { connectionId },
            ),
          );
          return true;
        },
        onNotice: (notice) => notices.push(notice),
        requestSessionApi: async (scope, request) => {
          if (request.method === 'GET')
            return Response.json({
              registration: {
                version: 1,
                leaseId: `lease-${scope.sessionId}`,
                revision: 1,
                label: scope.sessionId,
                eligible: true,
                active: scope.sessionId === 'source',
                requiresBrowserBind: true,
              },
            });
          const command = JSON.parse(String(request.body)) as (typeof commands)[number]['command'];
          commands.push({ sessionId: scope.sessionId, command });
          return Response.json({
            version: 1,
            epoch: command.epoch,
            generation: command.generation,
            revision: command.revision,
            phase: command.phase,
            ok: true,
            ...(command.phase === 'activate' || command.phase === 'resume' ? { listening: true } : {}),
          });
        },
      };
      const source = channel.start(host);
      try {
        source.sessionAdded?.(scopes.get('source')!);
        source.sessionAdded?.(scopes.get('target')!);
        channel.receive?.(
          scopes.get('source')!,
          { type: 'browser-media-runtime', version: 1 },
          { connectionId: 'browser' },
        );
        await flushMicrotasks();
        const initialHandle = commands.find(
          (entry) => entry.sessionId === 'source' && (entry.command.catalog?.targets.length ?? 0) > 0,
        )?.command.catalog?.targets[0]?.handle;
        if (!initialHandle) throw new Error('initial target handle unavailable');
        channel.receive?.(
          scopes.get('source')!,
          { version: 1, requestId: 'request-1', handle: initialHandle },
          { connectionId: 'browser' },
        );
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
        expect(dropped?.command.action).toBe(droppedAction);

        await vi.advanceTimersByTimeAsync(25);
        await flushMicrotasks();
        expect(notices.some((notice) => notice.includes(`${droppedAction} acknowledgement timed out`))).toBe(true);
        expect(commands.some((entry) => entry.sessionId === 'target' && entry.command.phase === 'abort')).toBe(true);
        expect(commands.some((entry) => entry.sessionId === 'source' && entry.command.phase === 'resume')).toBe(true);
        const restored = commands.findLast(
          (entry) =>
            entry.sessionId === 'source' &&
            entry.command.catalog?.owner === true &&
            entry.command.catalog.transaction === false &&
            entry.command.catalog.targets.length > 0,
        );
        expect(restored).toBeDefined();

        const late = dropped!;
        channel.receive?.(
          scopes.get(late.sessionId)!,
          { ...late.command, type: 'browser-media-ack', version: 1, ok: true },
          { connectionId: 'browser' },
        );
        const phasesAfterLateAcknowledgement = commands.length;
        await flushMicrotasks();
        expect(commands).toHaveLength(phasesAfterLateAcknowledgement);

        const restoredHandle = restored!.command.catalog!.targets[0]!.handle;
        channel.receive?.(
          scopes.get('source')!,
          { version: 1, requestId: 'request-2', handle: restoredHandle },
          { connectionId: 'browser' },
        );
        await vi.advanceTimersByTimeAsync(0);
        await flushMicrotasks();
        expect(
          commands.findLast((entry) => entry.sessionId === 'target' && entry.command.catalog?.owner === true)?.command
            .catalog?.transaction,
        ).toBe(false);
      } finally {
        source.close();
        vi.useRealTimers();
      }
    },
  );

  it('rejects and removes a pending browser acknowledgement when the channel closes', async () => {
    vi.useFakeTimers();
    const scopes = new Map([
      ['source', { sessionId: 'source', cwd: '/source' }],
      ['target', { sessionId: 'target', cwd: '/target' }],
    ]);
    const commands: Array<{
      sessionId: string;
      command: {
        epoch: string;
        generation: number;
        revision: number;
        phase: string;
        catalog?: { targets: Array<{ handle: string }> };
      };
    }> = [];
    const notices: string[] = [];
    const channel = createVoiceMediaWakeChannel(() => ({ close: () => undefined }), {
      browserAcknowledgementTimeoutMs: 25,
    });
    const host: HubChannelHost = {
      sessions: () => [...scopes.values()],
      publish: () => undefined,
      publishToConnection: () => true,
      onNotice: (notice) => notices.push(notice),
      requestSessionApi: async (scope, request) => {
        if (request.method === 'GET')
          return Response.json({
            registration: {
              version: 1,
              leaseId: `lease-${scope.sessionId}`,
              revision: 1,
              label: scope.sessionId,
              eligible: true,
              active: scope.sessionId === 'source',
              requiresBrowserBind: true,
            },
          });
        const command = JSON.parse(String(request.body)) as (typeof commands)[number]['command'];
        commands.push({ sessionId: scope.sessionId, command });
        return Response.json({
          version: 1,
          epoch: command.epoch,
          generation: command.generation,
          revision: command.revision,
          phase: command.phase,
          ok: true,
          ...(command.phase === 'activate' || command.phase === 'resume' ? { listening: true } : {}),
        });
      },
    };
    const source = channel.start(host);
    let closed = false;
    try {
      source.sessionAdded?.(scopes.get('source')!);
      source.sessionAdded?.(scopes.get('target')!);
      channel.receive?.(
        scopes.get('source')!,
        { type: 'browser-media-runtime', version: 1 },
        { connectionId: 'browser' },
      );
      await flushMicrotasks();
      const handle = commands.find(
        (entry) => entry.sessionId === 'source' && (entry.command.catalog?.targets.length ?? 0) > 0,
      )?.command.catalog?.targets[0]?.handle;
      if (!handle) throw new Error('target handle unavailable');
      channel.receive?.(
        scopes.get('source')!,
        { version: 1, requestId: 'request', handle },
        { connectionId: 'browser' },
      );
      await flushMicrotasks();
      source.close();
      closed = true;
      await flushMicrotasks();

      await vi.waitFor(() =>
        expect(notices.some((notice) => notice.includes('Voice media channel closed'))).toBe(true),
      );
      await vi.waitFor(() =>
        expect(commands.some((entry) => entry.sessionId === 'target' && entry.command.phase === 'abort')).toBe(true),
      );
      await vi.waitFor(() =>
        expect(commands.some((entry) => entry.sessionId === 'source' && entry.command.phase === 'resume')).toBe(true),
      );
      expect(vi.getTimerCount()).toBe(0);
      channel.receive?.(
        scopes.get('source')!,
        {
          type: 'browser-media-ack',
          version: 1,
          epoch: 'closed-epoch',
          generation: 2,
          revision: 1,
          action: 'detach',
          ok: true,
        },
        { connectionId: 'browser' },
      );
    } finally {
      if (!closed) source.close();
      vi.useRealTimers();
    }
  });
});
