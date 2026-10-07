import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/web/components/PluginSurface', () => ({
  PluginSurface: () => createElement('i', { 'data-testid': 'plugin-composer-action' }),
}));

const uploadSessionAttachment = vi.hoisted(() => vi.fn());
vi.mock('../../src/web/lib/sessionAsset', () => ({ uploadSessionAttachment }));

import {
  addComposerFiles,
  attachmentPrompt,
  Composer,
  readComposerFiles,
} from '../../src/web/features/session/Composer';
import {
  clearComposerState,
  composerStore,
  resetComposerStore,
  updateComposerState,
} from '../../src/web/stores/composerStore';
import { resetSessions, setActiveSession, sessionsStore } from '../../src/web/stores/sessionsStore';
import { applySessionLifecycle, dropSessionStore } from '../../src/web/stores/sessionStore';

afterEach(() => {
  resetSessions();
  resetComposerStore();
  dropSessionStore('active-session');
  uploadSessionAttachment.mockReset();
  vi.unstubAllGlobals();
});

function attachSession(): void {
  setActiveSession('active-session');
  sessionsStore.setState((state) => ({
    ...state,
    byId: {
      'active-session': {
        summary: {
          id: 'active-session',
          name: 'session',
          cwd: '/workspace',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          phase: 'idle',
          phaseSince: '2026-01-01T00:00:00.000Z',
          attach: 'attached',
          pendingMessageCount: 0,
          everPrompted: true,
          awaitingInput: false,
        },
        attach: 'attached',
        reason: '',
        replayed: 0,
        dropped: 0,
      },
    },
  }));
}

describe('Composer plugin actions', () => {
  it('renders one action surface without hiding it at either breakpoint', () => {
    const markup = renderToStaticMarkup(createElement(Composer));

    expect(markup.match(/data-testid="plugin-composer-action"/g)).toHaveLength(1);
    expect(markup).toContain('data-testid="composer-actions"');
    expect(markup).not.toMatch(/data-testid="composer-actions"[^>]*sm:hidden/);
  });

  it('does not present pending background work as queued messages before lifecycle reconnects', () => {
    setActiveSession('active-session');
    sessionsStore.setState((state) => ({
      ...state,
      byId: {
        'active-session': {
          summary: {
            id: 'active-session',
            name: 'session',
            cwd: '/workspace',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            phase: 'idle',
            phaseSince: '2026-01-01T00:00:00.000Z',
            attach: 'attached',
            pendingMessageCount: 2,
            everPrompted: true,
            awaitingInput: false,
          },
          attach: 'attached',
          reason: '',
          replayed: 0,
          dropped: 0,
        },
      },
    }));

    const markup = renderToStaticMarkup(createElement(Composer));
    expect(markup).not.toContain('data-testid="composer-queued"');
  });

  it('keeps Abort visible and disabled until the server reports terminal ownership', () => {
    setActiveSession('active-session');
    applySessionLifecycle('active-session', {
      revision: 1,
      operation: { id: 'turn-4', kind: 'run', status: 'aborting' },
      paused: true,
      queue: [],
    });
    const aborting = renderToStaticMarkup(createElement(Composer));
    expect(aborting).toContain('data-testid="composer-abort"');
    expect(aborting).toContain('aborting…');
    expect(aborting).toMatch(/data-testid="composer-abort"[^>]*disabled|disabled[^>]*data-testid="composer-abort"/);
    expect(aborting).not.toContain('data-testid="composer-queued"');

    applySessionLifecycle('active-session', { revision: 2, operation: null, paused: true, queue: [] });
    const idle = renderToStaticMarkup(createElement(Composer));
    expect(idle).not.toContain('data-testid="composer-abort"');
    expect(idle).not.toContain('data-testid="composer-queued"');
  });
});

describe('Composer file attachments', () => {
  const empty = { attachments: [], nextAttachmentId: 0 };

  it('uploads a PDF and tells the agent where it was saved', async () => {
    uploadSessionAttachment.mockResolvedValue({
      path: '/host/attachments/s/u/spec.pdf',
      mimeType: 'application/pdf',
      size: 4,
    });
    const pdf = new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' });

    const read = await readComposerFiles('s', [pdf], empty);

    expect(uploadSessionAttachment).toHaveBeenCalledWith('s', pdf);
    expect(read.attachmentError).toBe('');
    expect(read.attachments).toEqual([
      {
        id: 'attachment-0',
        kind: 'file',
        name: 'spec.pdf',
        size: 4,
        mimeType: 'application/pdf',
        path: '/host/attachments/s/u/spec.pdf',
      },
    ]);
    expect(attachmentPrompt('Attach this', read.attachments)).toBe(
      'Attach this\n\nAttached file "spec.pdf" (application/pdf, 4 bytes) saved at /host/attachments/s/u/spec.pdf. ' +
        'To send it to a tool\'s file parameter, pass {"path": "/host/attachments/s/u/spec.pdf"}.',
    );
  });

  it('reports a failed upload and a file over the upload limit without attaching them', async () => {
    uploadSessionAttachment.mockRejectedValue(new Error('offline'));
    const pdf = new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' });
    const huge = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'huge.zip', { type: 'application/zip' });

    const read = await readComposerFiles('s', [pdf, huge], empty);

    expect(read.attachments).toEqual([]);
    expect(read.attachmentError).toBe('"spec.pdf" could not be uploaded. "huge.zip" exceeds the 8 MB file limit.');
    expect(uploadSessionAttachment).toHaveBeenCalledTimes(1);
  });

  it('keeps an image inline and adds the stored path when the upload succeeds', async () => {
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(): void {
          this.result = 'data:image/png;base64,aW1n';
          this.onload?.();
        }
      },
    );
    uploadSessionAttachment.mockResolvedValue({ path: '/host/shot.png', mimeType: 'image/png', size: 3 });
    const png = new File(['img'], 'shot.png', { type: 'image/png' });

    const read = await readComposerFiles('s', [png], empty);

    expect(read.attachments).toEqual([
      {
        id: 'attachment-0',
        kind: 'image',
        name: 'shot.png',
        size: 3,
        dataUrl: 'data:image/png;base64,aW1n',
        data: 'aW1n',
        mimeType: 'image/png',
        path: '/host/shot.png',
      },
    ]);
    expect(attachmentPrompt('', read.attachments)).toBe(
      'Please review the attached image.\n\nAttached image "shot.png" is also saved at /host/shot.png. ' +
        'To send it to a tool\'s file parameter, pass {"path": "/host/shot.png"}.',
    );
  });

  it('keeps a text file inline when its best-effort upload fails', async () => {
    uploadSessionAttachment.mockRejectedValue(new Error('offline'));
    const notes = new File(['check the retry path'], 'notes.txt', { type: 'text/plain' });

    const read = await readComposerFiles('s', [notes], empty);

    expect(read.attachmentError).toBe('');
    expect(read.attachments).toEqual([
      { id: 'attachment-0', kind: 'text', name: 'notes.txt', size: 20, content: 'check the retry path' },
    ]);
    expect(attachmentPrompt('', read.attachments)).toBe('Attached file "notes.txt":\n\ncheck the retry path');
  });
});

describe('Composer attachments staged while uploads are pending', () => {
  const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
  const stored = (name: string) => ({ path: `/host/${name}`, mimeType: 'application/pdf', size: 4 });

  /** Each upload waits until the test releases it, in whatever order it chooses. */
  function deferUploads(): Map<string, () => void> {
    const release = new Map<string, () => void>();
    uploadSessionAttachment.mockImplementation(
      (_sessionId: string, file: File) =>
        new Promise((resolve) => release.set(file.name, () => resolve(stored(file.name)))),
    );
    return release;
  }

  it('keeps edits made meanwhile and gives concurrent batches their own ids', async () => {
    const release = deferUploads();
    updateComposerState('s', (state) => ({
      ...state,
      draft: 'first',
      attachments: [{ id: 'attachment-0', kind: 'text', name: 'old.txt', size: 3, content: 'old' }],
      nextAttachmentId: 1,
    }));

    const first = addComposerFiles('s', [pdf('a.pdf')]);
    const second = addComposerFiles('s', [pdf('b.pdf')]);
    expect(composerStore.state.s).toMatchObject({ pendingAttachments: 2, nextAttachmentId: 3 });

    updateComposerState('s', (state) => ({
      ...state,
      draft: 'typed meanwhile',
      attachments: state.attachments.filter((item) => item.id !== 'attachment-0'),
    }));
    release.get('b.pdf')?.();
    await second;
    expect(composerStore.state.s?.pendingAttachments).toBe(1);
    release.get('a.pdf')?.();
    await first;

    expect(composerStore.state.s).toMatchObject({
      draft: 'typed meanwhile',
      pendingAttachments: 0,
      attachmentError: '',
    });
    expect(composerStore.state.s?.attachments.map(({ id, name }) => [id, name])).toEqual([
      ['attachment-2', 'b.pdf'],
      ['attachment-1', 'a.pdf'],
    ]);
  });

  it('does not bring back attachments a send cleared, nor reuse their ids', async () => {
    const release = deferUploads();
    updateComposerState('s', (state) => ({
      ...state,
      attachments: [{ id: 'attachment-0', kind: 'text', name: 'sent.txt', size: 4, content: 'sent' }],
      nextAttachmentId: 1,
    }));

    const late = addComposerFiles('s', [pdf('late.pdf')]);
    clearComposerState('s');
    release.get('late.pdf')?.();
    await late;
    await addComposerFiles('s', []);

    expect(composerStore.state.s?.attachments.map(({ id, name }) => [id, name])).toEqual([
      ['attachment-1', 'late.pdf'],
    ]);
    expect(composerStore.state.s).toMatchObject({ nextAttachmentId: 2, pendingAttachments: 0 });
  });

  it('holds concurrent batches to the attachment count together', async () => {
    const release = deferUploads();
    const names = (prefix: string) => Array.from({ length: 5 }, (_, index) => `${prefix}${String(index)}.pdf`);

    const first = addComposerFiles('s', names('a').map(pdf));
    const second = addComposerFiles('s', names('b').map(pdf));
    // Uploads within one batch run one after another, so release them as they start.
    for (let index = 0; index < 5; index += 1) {
      release.get(`a${String(index)}.pdf`)?.();
      release.get(`b${String(index)}.pdf`)?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all([first, second]);

    expect(composerStore.state.s?.attachments).toHaveLength(8);
    expect(new Set(composerStore.state.s?.attachments.map((item) => item.id)).size).toBe(8);
    expect(composerStore.state.s?.attachmentError).toBe('Only 8 attachments are allowed.');
  });

  it('disables send and queue until pending files are staged', () => {
    attachSession();
    updateComposerState('active-session', (state) => ({ ...state, draft: 'look at this', pendingAttachments: 1 }));
    const disabledActions = () =>
      (
        renderToStaticMarkup(createElement(Composer)).match(/<button[^>]*data-testid="composer-(send|queue)"[^>]*>/g) ??
        []
      ).filter((tag) => tag.includes(' disabled=""'));

    expect(disabledActions()).toHaveLength(2);

    updateComposerState('active-session', (state) => ({ ...state, pendingAttachments: 0 }));
    expect(disabledActions()).toEqual([]);
  });
});
