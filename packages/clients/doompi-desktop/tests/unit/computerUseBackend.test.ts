import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  systemPreferences: {
    isTrustedAccessibilityClient: () => true,
    getMediaAccessStatus: () => 'granted',
  },
}));

import { createMacOsComputerUseBackend } from '../../src/adapters/macos/computerUseBackend';

const directories: string[] = [];

async function helper(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'doompi-helper-test-'));
  directories.push(directory);
  const executable = path.join(directory, 'helper');
  await writeFile(
    executable,
    `#!${process.execPath}
const operation = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const payload = JSON.parse(input || '{}');
  if (operation === 'record') {
    setInterval(() => {}, 1000);
    process.on('SIGINT', () => {
      console.log(JSON.stringify({ ok: true, result: { stopped: true, artifact: { kind: 'screen_recording', path: '/tmp/fixture.mp4', contentType: 'video/mp4', audioScope: 'target_application' } } }));
      process.exit(0);
    });
    console.log(JSON.stringify({ ok: true, result: { recording: true, audioScope: 'target_application' } }));
    if (payload.payload?.autoStop === true) {
      setTimeout(() => {
        console.log(JSON.stringify({ ok: true, result: { stopped: true, artifact: { kind: 'screen_recording', path: '/tmp/fixture.mp4', contentType: 'video/mp4', audioScope: 'target_application' } } }));
        process.exit(0);
      }, 5);
    }
    return;
  }
  if (operation === 'observe' && payload.request?.delay === true) {
    setInterval(() => {}, 1000);
    return;
  }
  if (operation === 'observe') {
    console.log(JSON.stringify({ ok: true, result: { snapshotId: 'snapshot-1', elements: [], screenshot: { mimeType: 'image/png', data: 'cG5n' } } }));
    return;
  }
  if (operation === 'act' && payload.request?.delay === true) {
    setInterval(() => {}, 1000);
    return;
  }
  console.log(JSON.stringify({ ok: true, result: operation === 'probe' ? { protocolVersion: 1, architecture: 'arm64' } : payload }));
});
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe('macOS computer-use backend', () => {
  it('rejects activation when the recording helper cannot be spawned', async () => {
    const backend = createMacOsComputerUseBackend({ helperPath: path.join(os.tmpdir(), 'missing-doompi-helper') });
    await expect(
      backend.activate({ sessionId: 'session', grantId: 'grant', runId: 'run', expiresAt: 10, payload: {} }),
    ).rejects.toThrow();
  });

  it('rejects activation when the recording helper is not executable', async () => {
    const executable = await helper();
    await chmod(executable, 0o644);
    const backend = createMacOsComputerUseBackend({ helperPath: executable });
    await expect(
      backend.activate({ sessionId: 'session', grantId: 'grant', runId: 'run', expiresAt: 10, payload: {} }),
    ).rejects.toThrow();
  });
  it('requires a successful helper probe before reporting the native adapter', async () => {
    const backend = createMacOsComputerUseBackend({ helperPath: await helper() });
    await expect(backend.status()).resolves.toMatchObject({
      accessibility: true,
      screenRecording: 'granted',
      nativeAdapter: 'available',
      probe: { protocolVersion: 1, architecture: 'arm64' },
    });
  });

  it('keeps the recording grant bound and returns a typed target-audio artifact', async () => {
    const backend = createMacOsComputerUseBackend({ helperPath: await helper() });
    await expect(
      backend.activate({ sessionId: 'session', grantId: 'grant', runId: 'run', expiresAt: 10, payload: {} }),
    ).resolves.toEqual({ recording: true, audioScope: 'target_application' });
    await expect(backend.observe({ sessionId: 'other', grantId: 'grant', payload: {} })).rejects.toThrow(
      'not active for this grant',
    );
    await expect(backend.stop({ sessionId: 'session', grantId: 'grant', reason: 'requested' })).resolves.toEqual({
      stopped: true,
      artifact: {
        kind: 'screen_recording',
        path: '/tmp/fixture.mp4',
        contentType: 'video/mp4',
        audioScope: 'target_application',
      },
    });
  });

  it('normalizes native observations to the public computer-state contract', async () => {
    const backend = createMacOsComputerUseBackend({ helperPath: await helper() });
    await backend.activate({
      sessionId: 'session',
      grantId: 'grant',
      runId: 'run',
      expiresAt: 10,
      payload: {
        target: {
          applicationName: 'Fixture',
          bundleId: 'com.example.fixture',
          processId: 123,
          windowId: '42',
          windowTitle: 'Fixture Window',
        },
      },
    });

    await expect(backend.observe({ sessionId: 'session', grantId: 'grant', payload: {} })).resolves.toEqual({
      runId: 'run',
      snapshotId: 'snapshot-1',
      targetGeneration: '123:42',
      applicationName: 'Fixture',
      bundleId: 'com.example.fixture',
      windowTitle: 'Fixture Window',
      elements: [],
      screenshot: { mimeType: 'image/png', data: 'cG5n' },
    });
    await backend.stop({ sessionId: 'session', grantId: 'grant', reason: 'requested' });
  });
  it('retains an artifact when recording finishes before stop is requested', async () => {
    const backend = createMacOsComputerUseBackend({ helperPath: await helper() });
    await backend.activate({
      sessionId: 'session',
      grantId: 'grant',
      runId: 'run',
      expiresAt: 10,
      payload: { autoStop: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(backend.stop({ sessionId: 'session', grantId: 'grant', reason: 'expired' })).resolves.toMatchObject({
      stopped: true,
      artifact: { audioScope: 'target_application' },
    });
  });
  it('terminates an in-flight semantic helper request when cancelled', async () => {
    const backend = createMacOsComputerUseBackend({ helperPath: await helper() });
    await backend.activate({ sessionId: 'session', grantId: 'grant', runId: 'run', expiresAt: 10, payload: {} });
    const controller = new AbortController();
    const observation = backend.observe({
      sessionId: 'session',
      grantId: 'grant',
      payload: { delay: true },
      signal: controller.signal,
    });
    controller.abort();
    await expect(observation).rejects.toThrow('cancelled');
    await backend.stop({ sessionId: 'session', grantId: 'grant', reason: 'requested' });
  });

  it('terminates in-flight semantic actions when the grant stops', async () => {
    const backend = createMacOsComputerUseBackend({ helperPath: await helper() });
    await backend.activate({ sessionId: 'session', grantId: 'grant', runId: 'run', expiresAt: 10, payload: {} });
    const action = backend.act({ sessionId: 'session', grantId: 'grant', sequence: 1, payload: { delay: true } });
    const rejection = expect(action).rejects.toThrow();
    await backend.stop({ sessionId: 'session', grantId: 'grant', reason: 'expired' });
    await rejection;
  });
});
