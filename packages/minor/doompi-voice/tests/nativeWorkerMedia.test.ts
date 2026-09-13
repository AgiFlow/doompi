import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveVoiceConfig } from '@agimon-ai/doompi-config';
import { expect, it, vi } from 'vitest';

import { VoiceMediaBroker } from '../src/controllers/clientMediaApi';
import { SystemClock } from '../src/services/infrastructure';
import { VoiceWorkerClient } from '../src/services/voiceWorkerClient';
import { VoiceWorkerSessionController } from '../src/services/voiceWorkerSessionController';
import {
  VOICE_MEDIA_EVENT_WAIT_NONE,
  VOICE_MEDIA_CONTENT_TYPE,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_ROUTES,
} from '../src/types/clientMedia';
import { testDirectEvents } from './support';

it('drains browser PCM through a real worker thread and appends the transcriber result to the native composer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-worker-native-'));
  const binary = join(root, 'transcriber');
  const model = join(root, 'model.bin');
  await writeFile(model, 'fixture');
  await writeFile(
    binary,
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const output=args[args.indexOf('--output-file')+1];fs.writeFileSync(output+'.txt','dictated native prompt');`,
    { mode: 0o700 },
  );
  const config = resolveVoiceConfig({
    engine: 'whisper-cpp',
    adapters: { 'whisper-cpp': { binary, model: { path: model } } },
  });
  const broker = new VoiceMediaBroker({ directEvents: testDirectEvents, clientConnectWaitMs: 0 });
  const json = async (path: string, body: object) =>
    broker.fetch(
      new Request(`http://voice${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const lease = { clientId: 'browser', connectionId: 'tab-one' };
  await json(VOICE_MEDIA_ROUTES.clientConnect, {
    ...lease,
    version: VOICE_MEDIA_PROTOCOL_VERSION,
    clientKind: 'browser',
    controlLocation: 'local',
    capabilities: { capture: true, playback: true, captureActivity: false, autonomousOrchestration: false },
  });
  const appendText = vi.fn();
  const notify = vi.fn();
  const ui = { appendText, notify, setStatus: vi.fn(), setIndicator: vi.fn() };
  const controller = new VoiceWorkerSessionController(
    { load: () => ({ projectTrust: 'ask' }) },
    new SystemClock(),
    (options) =>
      new VoiceWorkerClient({
        ...options,
        clientMedia: broker.media,
        importUrl: new URL('../dist/voiceWorker.mjs', import.meta.url),
      }),
    { loadConfig: () => config, spoolDirectory: join(root, 'spool'), environment: {} },
  );
  try {
    await controller.toggle(ui);
    expect(controller.state, JSON.stringify(notify.mock.calls)).toBe('recording');
    let captureId: string | undefined;
    await vi.waitFor(async () => {
      const response = await broker.fetch(
        new Request(
          `http://voice${VOICE_MEDIA_ROUTES.clientEvents}?clientId=browser&connectionId=tab-one&after=0&wait=${VOICE_MEDIA_EVENT_WAIT_NONE}`,
        ),
      );
      const body =
        response.status === 204 ? undefined : ((await response.json()) as { type: string; captureId?: string });
      captureId = body?.type === 'capture-start' ? body.captureId : undefined;
      expect(captureId, JSON.stringify({ body, notifications: notify.mock.calls })).toBeTruthy();
    });
    const pcm = Buffer.alloc(32_000);
    for (let sample = 0; sample < pcm.length / 2; sample++)
      pcm.writeInt16LE(Math.round(Math.sin(sample * 0.17) * 12_000), sample * 2);
    const uploaded = await broker.fetch(
      new Request(
        `http://voice${VOICE_MEDIA_ROUTES.clientAudio}?clientId=browser&connectionId=tab-one&captureId=${captureId}`,
        { method: 'POST', headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE }, body: pcm },
      ),
    );
    expect(uploaded.status).toBe(204);
    await controller.toggle(ui);
    await vi.waitFor(async () => {
      const response = await broker.fetch(
        new Request(
          `http://voice${VOICE_MEDIA_ROUTES.clientEvents}?clientId=browser&connectionId=tab-one&after=1&wait=${VOICE_MEDIA_EVENT_WAIT_NONE}`,
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: 'capture-stop', captureId });
    });
    await json(VOICE_MEDIA_ROUTES.clientCaptureStopped, { ...lease, captureId });
    await vi.waitFor(
      () =>
        expect(
          appendText,
          JSON.stringify({ state: controller.state, notifications: notify.mock.calls }),
        ).toHaveBeenCalledWith('dictated native prompt'),
      { timeout: 10_000 },
    );
    expect(controller.state).toBe('idle');
    expect(notify).not.toHaveBeenCalledWith(expect.anything(), 'error');
  } finally {
    await controller.shutdown(ui);
    broker.close();
    await rm(root, { recursive: true, force: true });
  }
});
