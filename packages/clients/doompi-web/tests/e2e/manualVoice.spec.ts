import { expect, test } from '../support/cockpit.ts';

test.use({ assets: 'synced' });

test('records once and appends the returned transcript without invoking autonomous voice', async ({
  page,
  cockpit,
}) => {
  const mediaRequests: Array<{
    url: string;
    method: string;
    contentType: string | undefined;
    duration: string | undefined;
    bodyLength: number;
  }> = [];

  await page.addInitScript(() => {
    class FakeMediaRecorder {
      public static isTypeSupported(type: string): boolean {
        return type === 'audio/webm;codecs=opus';
      }

      public readonly mimeType = 'audio/webm;codecs=opus';
      public state: 'inactive' | 'recording' = 'inactive';
      public ondataavailable: ((event: { data: Blob }) => void) | null = null;
      public onerror: ((event: { error?: Error }) => void) | null = null;
      public onstop: (() => void) | null = null;

      public start(): void {
        this.state = 'recording';
      }

      public stop(): void {
        this.ondataavailable?.({ data: new Blob(['recorded-audio'], { type: this.mimeType }) });
        this.state = 'inactive';
        this.onstop?.();
      }
    }

    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [
            {
              stop: () => {
                const state = globalThis as typeof globalThis & { __manualVoiceTrackStops?: number };
                state.__manualVoiceTrackStops = (state.__manualVoiceTrackStops ?? 0) + 1;
              },
            },
          ],
        }),
      },
    });
  });

  await page.route('**/api/plugin/voice-media/**', async (route) => {
    const request = route.request();
    mediaRequests.push({
      url: request.url(),
      method: request.method(),
      contentType: request.headers()['content-type'],
      duration: request.headers()['x-doom-audio-duration-ms'],
      bodyLength: request.postDataBuffer()?.byteLength ?? 0,
    });
    if (new URL(request.url()).pathname.endsWith('/manual/transcribe')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transcript: 'dictated text' }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unexpected' }),
    });
  });

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const voice = page.getByTestId('composer-voice-action');
  await expect(voice).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(voice).toBeVisible();

  await page.getByTestId('composer-input').fill('existing draft');
  await voice.click();
  await expect(voice).toHaveAttribute('data-voice-mode', 'manual');
  await voice.click();

  await expect(page.getByTestId('composer-input')).toHaveValue('existing draft dictated text');
  expect(mediaRequests).toHaveLength(1);
  expect(mediaRequests[0]).toMatchObject({
    method: 'POST',
    contentType: 'audio/webm;codecs=opus',
  });
  expect(mediaRequests[0]?.url).toContain('/api/plugin/voice-media/manual/transcribe?session=s1');
  expect(Number(mediaRequests[0]?.duration)).toBeGreaterThanOrEqual(0);
  expect(mediaRequests[0]?.bodyLength).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { __manualVoiceTrackStops?: number }).__manualVoiceTrackStops,
    ),
  ).toBe(1);
  expect(cockpit.session.received.filter((frame) => frame.type === 'prompt')).toEqual([]);
  expect(mediaRequests.some((request) => request.url.includes('/client/audio'))).toBe(false);

  await page.getByTestId('composer-send').click();
  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('existing draft dictated text');
});

test('cleans up after a failed transcription and retries successfully', async ({ page, cockpit }) => {
  const mediaRequests: Array<{
    url: string;
    method: string;
    contentType: string | undefined;
    duration: string | undefined;
    bodyLength: number;
  }> = [];
  let transcriptionAttempts = 0;

  await page.addInitScript(() => {
    class FakeMediaRecorder {
      public static isTypeSupported(type: string): boolean {
        return type === 'audio/webm;codecs=opus';
      }

      public readonly mimeType = 'audio/webm;codecs=opus';
      public state: 'inactive' | 'recording' = 'inactive';
      public ondataavailable: ((event: { data: Blob }) => void) | null = null;
      public onerror: ((event: { error?: Error }) => void) | null = null;
      public onstop: (() => void) | null = null;

      public start(): void {
        this.state = 'recording';
      }

      public stop(): void {
        this.ondataavailable?.({ data: new Blob(['recorded-audio'], { type: this.mimeType }) });
        this.state = 'inactive';
        this.onstop?.();
      }
    }

    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [
            {
              stop: () => {
                const state = globalThis as typeof globalThis & { __manualVoiceTrackStops?: number };
                state.__manualVoiceTrackStops = (state.__manualVoiceTrackStops ?? 0) + 1;
              },
            },
          ],
        }),
      },
    });
  });

  await page.route('**/api/plugin/voice-media/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    mediaRequests.push({
      url: request.url(),
      method: request.method(),
      contentType: request.headers()['content-type'],
      duration: request.headers()['x-doom-audio-duration-ms'],
      bodyLength: request.postDataBuffer()?.byteLength ?? 0,
    });
    if (pathname.endsWith('/manual/transcribe')) {
      transcriptionAttempts += 1;
      const failed = transcriptionAttempts === 1;
      await route.fulfill({
        status: failed ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(failed ? { error: 'transcriber unavailable' } : { transcript: 'retry transcript' }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unexpected' }),
    });
  });

  await page.goto(cockpit.url);
  await cockpit.session.waitForAttach();

  const voice = page.getByTestId('composer-voice-action');
  const input = page.getByTestId('composer-input');
  await expect(voice).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(voice).toBeVisible();

  await input.fill('existing draft');
  await voice.click();
  await expect(voice).toHaveAttribute('data-voice-phase', 'recording');
  await voice.click();

  await expect(voice).toHaveAttribute('data-voice-phase', 'idle');
  await expect(voice).toHaveAttribute('aria-label', 'transcriber unavailable');
  await expect(voice).toHaveAttribute('data-voice-mode', 'off');
  await expect(input).toHaveValue('existing draft');
  await expect(voice).toBeEnabled();
  expect(transcriptionAttempts).toBe(1);
  expect(mediaRequests).toHaveLength(1);
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { __manualVoiceTrackStops?: number }).__manualVoiceTrackStops,
    ),
  ).toBe(1);

  await voice.click();
  await expect(voice).toHaveAttribute('data-voice-phase', 'recording');
  await voice.click();

  await expect(input).toHaveValue('existing draft retry transcript');
  await expect(voice).toHaveAttribute('data-voice-phase', 'idle');
  expect(transcriptionAttempts).toBe(2);
  expect(mediaRequests).toHaveLength(2);
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { __manualVoiceTrackStops?: number }).__manualVoiceTrackStops,
    ),
  ).toBe(2);
  expect(cockpit.session.received.filter((frame) => frame.type === 'prompt')).toEqual([]);
  expect(mediaRequests.some((request) => request.url.includes('/client/audio'))).toBe(false);

  await page.getByTestId('composer-send').click();
  const sent = await cockpit.session.waitForCommand('prompt');
  expect(sent.message).toBe('existing draft retry transcript');
});
