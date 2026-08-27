import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileEditsDetailView } from '../../src/types/fileEditsApi.ts';
import { FilePanel } from '../../web/FilePanel.tsx';
import { files, storeDetail } from '../../web/filesStore.ts';

/**
 * The file tab, rendered.
 *
 * Static markup, so this covers what the panel puts on the page for a given
 * store: the trail, the two reading toggles, the menu trigger. Clicking through
 * the menu needs a real browser and stays with the Playwright suite.
 */

const SESSION = 's1';
const PATH = '/repo/packages/core/web/src/components/Deep.tsx';

function detailOf(overrides: Partial<FileEditsDetailView> = {}): FileEditsDetailView {
  return {
    path: PATH,
    relPath: 'packages/core/web/src/components/Deep.tsx',
    versions: [],
    cumulative: { additions: 3, removals: 1 },
    working: { content: 'plain text body', hash: 'h', unavailable: false },
    ...overrides,
  };
}

function render(detail?: FileEditsDetailView) {
  if (detail) storeDetail(SESSION, detail);
  const fixture = slotPropsFixture({ sessionId: SESSION });
  return renderPlugin(FilePanel, {
    ...fixture.props,
    filePath: detail?.path ?? PATH,
    relPath: detail?.relPath ?? 'packages/core/web/src/components/Deep.tsx',
  });
}

beforeEach(() => {
  files.reset();
});

describe('the file tab header', () => {
  it('mounts without throwing before any detail has arrived', () => {
    const rendered = render();
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('files-file-panel');
  });

  it('shows the path as a breadcrumb, collapsing the middle of a deep one', () => {
    const rendered = render(detailOf());
    expect(rendered.html).toContain('files-breadcrumb');
    expect(rendered.includes('packages')).toBe(true);
    expect(rendered.includes('Deep.tsx')).toBe(true);
    // The collapsed directories are not drawn; the tooltip carries the full path.
    expect(rendered.includes('core')).toBe(false);
  });

  it('offers preview and diff as the two reading views, and nothing else', () => {
    const rendered = render(detailOf());
    expect(rendered.html).toContain('files-view-preview');
    expect(rendered.html).toContain('files-view-diff');
    expect(rendered.html).not.toContain('files-view-source');
  });

  it('puts the acting verbs behind the menu rather than in the header', () => {
    const rendered = render(detailOf());
    expect(rendered.html).toContain('files-menu');
    // Radix renders menu contents into a portal on open, so the header itself
    // must carry no delete: that is the whole point of moving it.
    expect(rendered.html).not.toContain('>delete<');
  });

  it('shows the line counts the session changed', () => {
    const rendered = render(detailOf());
    expect(rendered.includes('+3')).toBe(true);
    expect(rendered.includes('-1')).toBe(true);
  });
});

describe('the file tab body', () => {
  it('opens on the preview, because clicking a file is a request to see the file', () => {
    storeDetail(SESSION, detailOf());
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilePanel, {
      ...fixture.props,
      filePath: PATH,
      relPath: 'notes.txt',
    });
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('data-testid="files-preview"');
    // A file with no grammar and no rendering of its own still gets a reading
    // view rather than an empty pane.
    expect(rendered.html).toContain('data-mode="text"');
    expect(rendered.html).toContain('files-preview-text');
  });

  it('shows a code file as highlighted source rather than flat text', () => {
    const detail = detailOf({
      relPath: 'src/app.ts',
      working: { content: 'const a = 1;', hash: 'h', unavailable: false },
    });
    storeDetail(SESSION, detail);
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilePanel, { ...fixture.props, filePath: PATH, relPath: 'src/app.ts' });
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('data-mode="code"');
  });

  it('shows a file the editor cannot hold as its bytes: a picture stays a picture', () => {
    const detail = detailOf({
      relPath: 'docs/shot.png',
      working: { content: '', hash: '', unavailable: true, reason: 'the file is binary' },
    });
    storeDetail(SESSION, detail);
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilePanel, { ...fixture.props, filePath: PATH, relPath: 'docs/shot.png' });
    expect(rendered.html).toContain('data-mode="media"');
    expect(rendered.html).toContain('files-preview-media');
    expect(rendered.html).toContain('/api/sessions/s1/file?path=docs%2Fshot.png');
  });

  it('says why a file it cannot read has nothing to show', () => {
    const rendered = render(
      detailOf({
        working: { content: '', hash: '', unavailable: true, reason: 'the file no longer exists' },
        cumulative: { additions: 0, removals: 0, note: 'the file no longer exists' },
      }),
    );
    expect(rendered.includes('the file no longer exists')).toBe(true);
  });
});
