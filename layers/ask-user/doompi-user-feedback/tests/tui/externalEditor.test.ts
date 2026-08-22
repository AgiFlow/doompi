import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editQuestionnaireText } from '../../src/tui/externalEditor.ts';

const originalEditor = process.env.EDITOR;
const originalVisual = process.env.VISUAL;

afterEach(() => {
  if (originalEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = originalEditor;
  if (originalVisual === undefined) delete process.env.VISUAL;
  else process.env.VISUAL = originalVisual;
});

describe.skipIf(process.platform === 'win32')('editQuestionnaireText', () => {
  it('returns content written by the configured editor', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'doompi-feedback-editor-test-'));
    const editor = path.join(directory, 'editor.sh');
    try {
      await writeFile(editor, '#!/bin/sh\nprintf "edited externally" > "$1"\n', 'utf8');
      await chmod(editor, 0o755);
      delete process.env.VISUAL;
      process.env.EDITOR = editor;

      await expect(editQuestionnaireText('original')).resolves.toEqual({
        status: 'complete',
        content: 'edited externally',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns a typed failure when the editor exits unsuccessfully', async () => {
    delete process.env.VISUAL;
    process.env.EDITOR = 'false';

    await expect(editQuestionnaireText('original')).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('code 1'),
    });
  });
});
