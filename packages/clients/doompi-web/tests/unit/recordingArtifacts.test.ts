import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ComputerUseHostBinding, HubSessionScope } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecordingArtifactStore } from '../../src/services/recordingArtifacts.ts';

const directories: string[] = [];
const scope = { sessionId: 'session-1' } as HubSessionScope;

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('recording artifact store', () => {
  it('replaces Desktop paths with session-authorized URLs and streams byte ranges', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-recording-test-'));
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-recording-store-test-'));
    directories.push(directory, storage);
    const filePath = path.join(directory, 'recording.mp4');
    fs.writeFileSync(filePath, '0123456789');
    const desktop: ComputerUseHostBinding = {
      available: true,
      request: vi.fn(async () => ({
        stopped: true,
        artifact: {
          kind: 'screen_recording',
          path: filePath,
          contentType: 'video/mp4',
          audioScope: 'target_application',
        },
      })),
    };
    const store = createRecordingArtifactStore(desktop, Date.now, () => 'artifact-1', storage);

    const result = (await store.binding?.request(scope, { operation: 'stop' })) as Record<string, unknown>;
    expect(result).toEqual({
      artifactId: 'artifact-1',
      status: 'ready',
      previewUrl: '/api/sessions/session-1/computer-use/artifacts/artifact-1',
      downloadUrl: '/api/sessions/session-1/computer-use/artifacts/artifact-1?download=1',
    });
    expect(JSON.stringify(result)).not.toContain(filePath);

    const denied = store.response('another-session', 'artifact-1', undefined, false, false);
    expect(denied.status).toBe(404);
    const response = store.response('session-1', 'artifact-1', 'bytes=2-5', false, false);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await response.text()).toBe('2345');

    store.close();
    expect(fs.existsSync(filePath)).toBe(true);
    await vi.waitFor(() => expect(fs.existsSync(path.join(storage, 'artifact-1.mp4'))).toBe(false));
  });

  it('reports recording failures without exposing untrusted paths', async () => {
    const desktop: ComputerUseHostBinding = {
      available: true,
      request: vi.fn(async () => ({ stopped: true })),
    };
    const store = createRecordingArtifactStore(desktop, Date.now, () => 'artifact-2');

    await expect(store.binding?.request(scope, { operation: 'stop' })).resolves.toMatchObject({
      artifactId: 'artifact-2',
      status: 'failed',
      failure: { code: 'recording_failed' },
    });
  });

  it('validates typed Desktop metadata and forwards non-stop operations unchanged', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-recording-metadata-store-test-'));
    directories.push(storage);
    const missingPath = path.join(os.tmpdir(), 'missing-recording.mp4');
    const results: unknown[] = [
      { observed: true },
      {
        artifactId: 'typed-failure',
        status: 'failed',
        actionCount: 2,
        completedAt: '2026-09-06T00:00:00.000Z',
        failure: { code: 'capture_failed', message: 'denied' },
      },
      { artifactId: 'relative', status: 'ready', filePath: 'relative.mp4' },
      { artifactId: 'missing', status: 'ready', filePath: missingPath, mimeType: 'application/octet-stream' },
      { artifactId: 'bad/id', status: 'ready' },
    ];
    const close = vi.fn();
    const desktop: ComputerUseHostBinding = {
      available: true,
      request: vi.fn(async () => results.shift()),
      close,
    };
    const store = createRecordingArtifactStore(desktop, Date.now, undefined, storage);

    await expect(store.binding?.request(scope, { operation: 'observe' })).resolves.toEqual({ observed: true });
    await expect(store.binding?.request(scope, { operation: 'stop' })).resolves.toEqual({
      artifactId: 'typed-failure',
      status: 'failed',
      actionCount: 2,
      completedAt: '2026-09-06T00:00:00.000Z',
      failure: { code: 'capture_failed', message: 'denied' },
    });
    await expect(store.binding?.request(scope, { operation: 'stop' })).resolves.toMatchObject({
      artifactId: 'relative',
      status: 'failed',
      failure: { code: 'recording_unavailable' },
    });
    await expect(store.binding?.request(scope, { operation: 'stop' })).resolves.toMatchObject({
      artifactId: 'missing',
      status: 'failed',
      failure: { code: 'recording_unavailable' },
    });
    await expect(store.binding?.request(scope, { operation: 'stop' })).resolves.toBeUndefined();

    store.close();
    expect(close).toHaveBeenCalledOnce();
    expect(createRecordingArtifactStore(undefined, Date.now, undefined, storage).binding).toBeUndefined();
  });

  it('serves full, suffix, open, invalid, HEAD, empty, changed, missing, and expired artifacts', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-recording-response-test-'));
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-recording-response-store-test-'));
    directories.push(directory, storage);
    const values = new Map([
      ['full', '0123456789'],
      ['empty', ''],
      ['changed', 'abc'],
      ['missing', 'xyz'],
      ['expired', 'old'],
    ]);
    for (const [id, contents] of values) fs.writeFileSync(path.join(directory, `${id}.mp4`), contents);
    let currentId = 'full';
    let now = 1;
    const desktop: ComputerUseHostBinding = {
      available: true,
      request: vi.fn(async () => ({
        stopped: true,
        artifact: {
          kind: 'screen_recording',
          path: path.join(directory, `${currentId}.mp4`),
          contentType: 'video/mp4',
          audioScope: 'target_application',
        },
      })),
    };
    const store = createRecordingArtifactStore(
      desktop,
      () => now,
      () => currentId,
      storage,
    );
    const publish = async (id: string) => {
      currentId = id;
      await store.binding?.request(scope, { operation: 'stop' });
    };

    await publish('full');
    const full = store.response(scope.sessionId, 'full', undefined, true, false);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-disposition')).toContain('attachment');
    expect(await full.text()).toBe('0123456789');
    expect(await store.response(scope.sessionId, 'full', 'bytes=-3', false, false).text()).toBe('789');
    expect(await store.response(scope.sessionId, 'full', 'bytes=7-', false, false).text()).toBe('789');
    expect(store.response(scope.sessionId, 'full', 'bytes=20-30', false, false).status).toBe(416);
    expect(store.response(scope.sessionId, 'full', undefined, false, true).status).toBe(200);

    await publish('empty');
    expect(store.response(scope.sessionId, 'empty', undefined, false, false).status).toBe(200);

    await publish('changed');
    fs.appendFileSync(path.join(storage, 'changed.mp4'), 'changed');
    expect(store.response(scope.sessionId, 'changed', undefined, false, false).status).toBe(410);

    await publish('missing');
    fs.unlinkSync(path.join(storage, 'missing.mp4'));
    expect(store.response(scope.sessionId, 'missing', undefined, false, false).status).toBe(410);

    await publish('expired');
    now += 25 * 60 * 60 * 1000;
    expect(store.response(scope.sessionId, 'expired', undefined, false, false).status).toBe(404);
    store.close();
  });
});
