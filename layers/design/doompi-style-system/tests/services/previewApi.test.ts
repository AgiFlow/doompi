import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPreviewApi } from '../../src/services/previewApi';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-style-api-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('story preview API', () => {
  it('rejects malformed JSON without invoking the bundler', async () => {
    const response = await createPreviewApi(root).request('/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'The preview request body is not JSON.' });
  });

  it('requires exact story preview coordinates', async () => {
    const response = await createPreviewApi(root).request('/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appPath: '.', storyPath: 'Button.stories.tsx' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'A preview requires appPath, storyPath, and an exact storyExport.',
    });
  });
});
