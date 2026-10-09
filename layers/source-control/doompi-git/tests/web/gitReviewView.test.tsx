import { renderPlugin } from '@agimon-ai/doompi-core/webTesting';
import type { ButtonProps, ReviewCommentDraftProps } from '@agimon-ai/doompi-web-components';
import { createElement, type KeyboardEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitReviewBrowser } from '../../src/extensions/workspaces/sessions/(frontend)/_components/GitReviewBrowser';
import {
  GitReviewView,
  type ReviewFileState,
  type GitReviewViewProps,
  type ReviewSummaryState,
} from '../../src/extensions/workspaces/sessions/(frontend)/_components/GitReviewView';
import type { GitReviewSummary } from '../../src/types/gitReview';

const observed = vi.hoisted(() => ({
  buttons: [] as ButtonProps[],
  drafts: [] as ReviewCommentDraftProps[],
}));

// Keep real rendering and hooks. Record the child contracts to exercise parent callback delegation.
vi.mock('@agimon-ai/doompi-web-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agimon-ai/doompi-web-components')>();
  return {
    ...actual,
    Button: (props: ButtonProps) => {
      observed.buttons.push(props);
      return createElement(actual.Button, props);
    },
    ReviewCommentDraft: (props: ReviewCommentDraftProps) => {
      observed.drafts.push(props);
      return createElement(actual.ReviewCommentDraft, props);
    },
  };
});

function propsFor(summary: ReviewSummaryState): GitReviewViewProps {
  return {
    sync: { onSync: vi.fn(), onForcePush: vi.fn(), onAskAgent: vi.fn(), onDismissError: vi.fn() },
    summary,
    files: {},
    comments: [],
    onLoadFile: vi.fn(),
    onAddComment: vi.fn(),
    onRemoveComment: vi.fn(),
    onSendReview: vi.fn(),
    onDiscard: vi.fn(),
  };
}

beforeEach(() => {
  observed.buttons.length = 0;
  observed.drafts.length = 0;
});

describe('review file windowing', () => {
  it('keeps navigation targets without mounting hundreds of ready diff bodies', () => {
    const summary: GitReviewSummary = {
      repository: true,
      files: Array.from({ length: 300 }, (_, index) => ({
        path: `file-${String(index)}.ts`,
        status: 'modified',
        added: 1,
        removed: 0,
      })),
    };
    const files: Record<string, ReviewFileState> = Object.fromEntries(
      summary.files.map(({ path }) => [
        path,
        {
          state: 'ready',
          diff: { path, hunks: [{ start: 1, rows: [{ marker: '+', line: 1, content: 'offscreen content' }] }] },
        },
      ]),
    );
    const noop = vi.fn();
    const rendered = renderPlugin(GitReviewView, {
      sync: { onSync: noop, onForcePush: noop, onAskAgent: noop, onDismissError: noop },
      summary: { state: 'ready', summary },
      files,
      comments: [],
      onLoadFile: noop,
      onAddComment: noop,
      onRemoveComment: noop,
      onSendReview: noop,
      onDiscard: noop,
    });
    expect(rendered.error).toBeUndefined();
    const markup = rendered.html;
    expect(markup.match(/data-testid="git-review-file-/gu)).toHaveLength(300);
    expect(markup).not.toContain('data-diff-surface');
    expect(markup).not.toContain('offscreen content');
    expect(noop).not.toHaveBeenCalled();
  });
  it('pins an open draft with its inline comments even before viewport observation', () => {
    const noop = vi.fn();
    const rendered = renderPlugin(GitReviewView, {
      sync: { onSync: noop, onForcePush: noop, onAskAgent: noop, onDismissError: noop },
      summary: {
        state: 'ready',
        summary: {
          repository: true,
          files: [
            { path: 'draft.ts', status: 'modified', added: 1, removed: 1 },
            { path: 'other.ts', status: 'modified', added: 1, removed: 0 },
          ],
        },
      },
      files: {
        'draft.ts': {
          state: 'ready',
          diff: {
            path: 'draft.ts',
            hunks: [
              {
                start: 1,
                rows: [
                  { marker: '-', line: 1, content: 'old code' },
                  { marker: '+', line: 1, content: 'new code' },
                ],
              },
            ],
          },
        },
      },
      initialDraft: { path: 'draft.ts', selection: { side: 'new', startLine: 1, endLine: 1, snippet: 'new code' } },
      comments: [
        {
          id: 'note',
          path: 'draft.ts',
          relPath: 'draft.ts',
          side: 'old',
          startLine: 1,
          snippet: 'old code',
          body: 'keep the intent',
        },
      ],
      onLoadFile: noop,
      onAddComment: noop,
      onRemoveComment: noop,
      onSendReview: noop,
      onDiscard: noop,
    });
    expect(rendered.error).toBeUndefined();
    expect(rendered.html.match(/data-diff-surface=/gu)).toHaveLength(1);
    expect(rendered.html).toContain('keep the intent');
    expect(rendered.html).toContain('textarea');
  });

  it.each<{ summary: ReviewSummaryState; message: string }>([
    { summary: { state: 'loading' }, message: 'reading changes' },
    { summary: { state: 'error', error: 'changes refused' }, message: 'changes refused' },
    { summary: { state: 'ready', summary: { repository: false, files: [] } }, message: 'not a git checkout' },
    { summary: { state: 'ready', summary: { repository: true, files: [] } }, message: 'nothing uncommitted' },
    {
      summary: { state: 'ready', summary: { repository: true, files: [], base: 'main' } },
      message: 'nothing differs from main',
    },
  ])('renders summary status: $message', ({ summary, message }) => {
    const rendered = renderPlugin(GitReviewView, propsFor(summary));
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain(message);
    expect(rendered.html).not.toContain('data-review-path');
  });

  it.each<{ state: ReviewFileState | undefined; message: string }>([
    { state: undefined, message: 'loading diff' },
    { state: { state: 'loading' }, message: 'loading diff' },
    { state: { state: 'error', error: 'file refused' }, message: 'file refused' },
    {
      state: { state: 'ready', diff: { path: 'note.ts', hunks: [], binary: true } },
      message: 'binary file, not drawn',
    },
    {
      state: { state: 'ready', diff: { path: 'note.ts', hunks: [], tooLarge: true } },
      message: 'this diff is too large',
    },
    { state: { state: 'ready', diff: { path: 'note.ts', hunks: [] } }, message: 'no lines changed' },
  ])('keeps a pinned file status visible: $message', ({ state, message }) => {
    const props = propsFor({
      state: 'ready',
      summary: {
        repository: true,
        truncated: true,
        files: [{ path: 'note.ts', status: 'modified', added: 0, removed: 0 }],
      },
    });
    props.files = { 'note.ts': state };
    props.initialDraft = { path: 'note.ts', selection: { side: 'new', startLine: 1, endLine: 1, snippet: '' } };
    const rendered = renderPlugin(GitReviewView, props);
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain(message);
    expect(rendered.html).toContain('more files changed');
    if (state?.state === 'error') {
      observed.buttons.find((button) => button.children === 'retry')?.onClick?.({} as never);
      expect(props.onLoadFile).toHaveBeenCalledWith('note.ts');
    }
  });

  it.each(['submit', 'cancel'] as const)('%s the pinned draft and delegates comment/review actions', (action) => {
    const props = propsFor({
      state: 'ready',
      summary: { repository: true, files: [{ path: 'note.ts', status: 'modified', added: 1, removed: 0 }] },
    });
    props.files = {
      'note.ts': {
        state: 'ready',
        diff: {
          path: 'note.ts',
          hunks: [
            {
              start: 1,
              rows: [
                { marker: '+', line: 1, content: 'new code' },
                { marker: ' ', line: 2, content: 'context' },
              ],
            },
          ],
        },
      },
    };
    props.initialDraft = { path: 'note.ts', selection: { side: 'new', startLine: 1, endLine: 1, snippet: 'new code' } };
    props.comments = [
      {
        id: 'note',
        path: 'note.ts',
        relPath: 'note.ts',
        snippet: 'new code',
        startLine: 1,
        endLine: 1,
        body: 'keep it',
      },
    ];
    props.sendError = 'not connected';
    props.onDraftChange = vi.fn();
    const rendered = renderPlugin(GitReviewView, props);
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('not connected');
    if (action === 'submit') {
      observed.drafts[0]?.onSubmit('  updated comment  ');
      expect(props.onAddComment).toHaveBeenCalledWith({
        path: 'note.ts',
        relPath: 'note.ts',
        side: 'new',
        startLine: 1,
        endLine: 1,
        snippet: 'new code',
        body: 'updated comment',
      });
    } else {
      observed.drafts[0]?.onCancel();
      expect(props.onAddComment).not.toHaveBeenCalled();
    }
    expect(props.onDraftChange).toHaveBeenCalledWith(false);
    observed.buttons.find((button) => button['aria-label'] === 'remove comment')?.onClick?.({} as never);
    expect(props.onRemoveComment).toHaveBeenCalledWith('note');
    observed.buttons.find((button) => button.children === 'discard')?.onClick?.({} as never);
    expect(props.onDiscard).toHaveBeenCalledOnce();
    observed.buttons.find((button) => button.children === 'send review')?.onClick?.({} as never);
    expect(props.onSendReview).toHaveBeenCalledOnce();
  });

  it.each([
    { key: 'ArrowDown', activePath: 'a.ts', expected: 'b.ts', index: 1 },
    { key: 'ArrowUp', activePath: 'a.ts', expected: 'b.ts', index: 1 },
    { key: 'ArrowDown', activePath: 'missing.ts', expected: 'a.ts', index: 0 },
    { key: 'Enter', activePath: 'a.ts', expected: undefined, index: 0 },
  ])('keeps keyboard file navigation working: $key from $activePath', ({ key, activePath, expected, index }) => {
    const onPick = vi.fn();
    const rendered = renderPlugin(GitReviewBrowser, {
      files: [
        { path: 'a.ts', status: 'deleted', added: 0, removed: 1 },
        { path: 'b.ts', status: 'added', added: 1, removed: 0, binary: true },
      ],
      activePath,
      commentCounts: { 'b.ts': 2 },
      onPick,
    });
    expect(rendered.error).toBeUndefined();
    const focus = [vi.fn(), vi.fn()];
    const preventDefault = vi.fn();
    const currentTarget = {
      closest: () => ({ querySelectorAll: () => focus.map((callback) => ({ focus: callback })) }),
    };
    observed.buttons
      .find((button) => button.title === 'a.ts (deleted)')
      ?.onKeyDown?.({
        key,
        preventDefault,
        currentTarget,
      } as unknown as KeyboardEvent<HTMLButtonElement>);
    if (expected === undefined) {
      expect(onPick).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
    } else {
      expect(onPick).toHaveBeenCalledWith(expected);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus[index]).toHaveBeenCalledOnce();
    }
  });

  it.each([0, 1, 2])('preserves paused-rebase context for %i conflicting paths', (count) => {
    const props = propsFor({ state: 'ready', summary: { repository: true, files: [], mergeBase: 'abc1234' } });
    props.sync.changes = {
      branch: 'feature',
      base: 'main',
      added: 1,
      removed: 0,
      files: 1,
      truncated: true,
      upstream: { ref: 'origin/feature', ahead: 1, behind: 2 },
      rebase: { conflicts: Array.from({ length: count }, (_, index) => `conflict-${String(index)}.ts`) },
    };
    const rendered = renderPlugin(GitReviewView, props);
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('abc1234');
    expect(rendered.html).toContain('rebase paused');
    expect(rendered.html).toContain(count === 0 ? 'git stopped the rebase' : `conflicts in ${String(count)}`);
    const syncButtons = observed.buttons.filter(
      (button) => typeof button.children === 'string' && ['pull', 'push', 'rebase'].includes(button.children),
    );
    expect(syncButtons).toHaveLength(3);
    expect(syncButtons.every((button) => button.disabled)).toBe(true);
    observed.buttons.find((button) => button.children === 'abort rebase')?.onClick?.({} as never);
    expect(props.sync.onSync).toHaveBeenCalledWith('abort-rebase');
  });

  it('preserves pending, rejected-force-push and dismissible error feedback', () => {
    const props = propsFor({ state: 'loading' });
    props.sync.pending = 'pushing';
    props.sync.error = 'push rejected';
    props.sync.errorTarget = { action: 'push', forceRequired: true };
    let rendered = renderPlugin(GitReviewView, props);
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('git-sync-pending');
    expect(rendered.html).toContain('git-push-force-confirm');
    expect(rendered.html).not.toContain('git-sync-error');
    expect(observed.buttons.find((button) => button.children === 'force push')?.disabled).toBe(true);
    props.sync.pending = undefined;
    props.sync.errorTarget = { action: 'pull' };
    rendered = renderPlugin(GitReviewView, props);
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('push rejected');
    expect(rendered.html).not.toContain('git-push-force-confirm');
    observed.buttons.find((button) => button.children === 'dismiss')?.onClick?.({} as never);
    expect(props.sync.onDismissError).toHaveBeenCalledOnce();
  });
});
