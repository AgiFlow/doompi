import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileEditsDetailView, FileEditsDiffHunk } from '../../src/types/fileEditsApi.ts';
import { CommentDraft } from '../../web/CommentDraft.tsx';
import { DeleteFileDialog } from '../../web/DeleteFileDialog.tsx';
import { DiffView } from '../../web/DiffView.tsx';
import { FilePanel } from '../../web/FilePanel.tsx';
import { FilesActivitySection } from '../../web/FilesActivitySection.tsx';
import { addComment, files, filesChannel, storeDetail, storeError } from '../../web/filesStore.ts';

/**
 * Every surface this plugin puts on the page, rendered once.
 *
 * The host catches a component that throws and swaps in a fallback, so a
 * broken panel is invisible until someone opens it. Static markup is enough to
 * catch that, and to pin what each surface says for a given store.
 */

const SESSION = 's1';

const HUNKS: FileEditsDiffHunk[] = [
  {
    start: 1,
    rows: [
      { marker: ' ', line: 1, content: 'unchanged' },
      { marker: '-', line: 2, content: 'gone' },
      { marker: '+', line: 2, content: 'added' },
    ],
  },
  { start: 40, rows: [{ marker: '+', line: 40, content: 'later' }] },
];

const item = (relPath: string, overrides: Record<string, unknown> = {}) => ({
  path: `/repo/${relPath}`,
  relPath,
  tool: 'edit' as const,
  at: 10,
  count: 1,
  diffable: true,
  ...overrides,
});

function detailOf(overrides: Partial<FileEditsDetailView> = {}): FileEditsDetailView {
  return {
    path: '/repo/app.ts',
    relPath: 'app.ts',
    versions: [],
    cumulative: { additions: 0, removals: 0 },
    working: { content: 'body', hash: 'h', unavailable: false },
    ...overrides,
  };
}

beforeEach(() => {
  files.reset();
});

describe('DiffView', () => {
  it('draws every row with its number and marker', () => {
    const rendered = renderPlugin(DiffView, { hunks: HUNKS, testId: 'd' });
    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('unchanged')).toBe(true);
    expect(rendered.includes('gone')).toBe(true);
    expect(rendered.includes('added')).toBe(true);
    expect(rendered.html).toContain('data-diff-line="40"');
  });

  it('marks the gap between two hunks rather than joining them', () => {
    const rendered = renderPlugin(DiffView, { hunks: HUNKS, testId: 'd' });
    expect(rendered.includes('⋯')).toBe(true);
  });

  it('says so when a change moved no lines', () => {
    const rendered = renderPlugin(DiffView, { hunks: [], testId: 'd' });
    expect(rendered.includes('no lines changed')).toBe(true);
  });
});

describe('CommentDraft', () => {
  it('shows the quoted selection and the range it covers', () => {
    const rendered = renderPlugin(CommentDraft, {
      snippet: 'const retries = 3;',
      startLine: 12,
      endLine: 14,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    });
    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('lines 12 to 14')).toBe(true);
    expect(rendered.includes('const retries = 3;')).toBe(true);
  });

  it('names a single line in the singular', () => {
    const rendered = renderPlugin(CommentDraft, {
      snippet: 'x',
      startLine: 12,
      onSubmit: () => undefined,
      onCancel: () => undefined,
    });
    expect(rendered.includes('line 12')).toBe(true);
  });

  it('admits when a selection has no line anchor at all', () => {
    const rendered = renderPlugin(CommentDraft, {
      snippet: 'rendered text',
      onSubmit: () => undefined,
      onCancel: () => undefined,
    });
    expect(rendered.includes('no line anchor')).toBe(true);
  });
});

describe('DeleteFileDialog', () => {
  // Radix puts dialog content in a portal, which static markup cannot render,
  // so what this level proves is that the confirmation mounts in either state
  // without throwing. Its wording is read by the Playwright suite.
  it.each([
    ['open', true],
    ['closed', false],
  ])('mounts %s without throwing', (_name, open) => {
    const rendered = renderPlugin(DeleteFileDialog, {
      relPath: 'src/app.ts',
      open,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    expect(rendered.error).toBeUndefined();
  });
});

describe('FilesActivitySection', () => {
  it('says nothing has changed before the session touches a file', () => {
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilesActivitySection, fixture.props);
    expect(rendered.includes('nothing changed yet')).toBe(true);
  });

  it('lists each changed file with its metadata, and marks one with no diff', () => {
    filesChannel.apply(
      SESSION,
      filesChannel.parse({
        items: [item('src/app.ts', { count: 4 }), item('gen.txt', { tool: 'bash', diffable: false })],
      })!,
    );
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilesActivitySection, fixture.props);
    expect(rendered.includes('src/app.ts')).toBe(true);
    expect(rendered.includes('4×')).toBe(true);
    expect(rendered.includes('command')).toBe(true);
    expect(rendered.html).toContain('data-file-diffable="false"');
    expect(rendered.html).toContain('changed by a command, so no diff was captured');
    expect(rendered.html).not.toContain('activity-files-show-all');
  });

  it('draws only five compact rows and offers the complete total', () => {
    const many = Array.from({ length: 6 }, (_, index) => item(`file-${String(index)}.ts`));
    filesChannel.apply(SESSION, filesChannel.parse({ items: many })!);
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilesActivitySection, fixture.props);
    expect(rendered.html.match(/data-file-diffable=/gu)).toHaveLength(5);
    expect(rendered.includes('file-4.ts')).toBe(true);
    expect(rendered.includes('file-5.ts')).toBe(false);
    expect(rendered.includes('show all 6 files')).toBe(true);
    expect(rendered.html).toContain('aria-label="show all 6 changed files"');
  });

  it('shows every compact row without show all when there are exactly five', () => {
    filesChannel.apply(
      SESSION,
      filesChannel.parse({ items: Array.from({ length: 5 }, (_, index) => item(`file-${String(index)}.ts`)) })!,
    );
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilesActivitySection, fixture.props);
    expect(rendered.html.match(/data-file-diffable=/gu)).toHaveLength(5);
    expect(rendered.html).not.toContain('activity-files-show-all');
  });
});

describe('FilePanel body', () => {
  it('opens a file with a full history on its preview, and offers the diff beside it', () => {
    // The tab opens on the preview, so the diff pane and the version list under
    // it are behind a click and out of reach of static markup. What this can
    // still hold is that a panel carrying a whole history mounts, says what the
    // session did to the file, and offers the way through to it. The rows
    // themselves are DiffView's, covered above.
    storeDetail(
      SESSION,
      detailOf({
        cumulative: { additions: 1, removals: 1, hunks: HUNKS },
        versions: [
          { index: 1, tool: 'edit', at: 0, origin: 'tool', additions: 1, removals: 1, hunks: HUNKS },
          { index: 2, tool: 'bash', at: 0, origin: 'scan', additions: 0, removals: 0, note: 'no baseline' },
        ],
      }),
    );
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilePanel, { ...fixture.props, filePath: '/repo/app.ts', relPath: 'app.ts' });
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('files-view-diff');
    expect(rendered.includes('+1')).toBe(true);
    expect(rendered.includes('-1')).toBe(true);
    expect(rendered.html).toContain('data-mode="code"');
  });

  it('reports a failed read rather than an empty panel', () => {
    storeError(SESSION, '/repo/app.ts', 'The session is unreachable.');
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilePanel, { ...fixture.props, filePath: '/repo/app.ts', relPath: 'app.ts' });
    expect(rendered.includes('The session is unreachable.')).toBe(true);
  });

  it('shows the queued review and its send control once a comment exists', () => {
    storeDetail(SESSION, detailOf());
    addComment(SESSION, {
      id: 'c1',
      path: '/repo/app.ts',
      relPath: 'app.ts',
      startLine: 12,
      snippet: 'x',
      body: 'this retry is unbounded',
    });
    const fixture = slotPropsFixture({ sessionId: SESSION });
    const rendered = renderPlugin(FilePanel, { ...fixture.props, filePath: '/repo/app.ts', relPath: 'app.ts' });
    expect(rendered.includes('1 comment')).toBe(true);
    expect(rendered.includes('app.ts:12')).toBe(true);
    expect(rendered.html).toContain('files-send-review');
  });

  it('survives a session it was handed nothing for', () => {
    const fixture = slotPropsFixture({ sessionId: null });
    const rendered = renderPlugin(FilePanel, { ...fixture.props, filePath: '/repo/app.ts', relPath: 'app.ts' });
    expect(rendered.error).toBeUndefined();
  });
});
