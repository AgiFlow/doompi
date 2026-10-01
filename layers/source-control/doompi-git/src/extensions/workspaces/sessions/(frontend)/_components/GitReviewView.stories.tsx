/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The view takes everything as props, so each state is data: no
 * fetch is stubbed and no store is seeded.
 */
import type { ReviewComment } from '@agimon-ai/doompi-web-components';
import type { ReactNode } from 'react';

import type { GitChangesView, GitReviewFileDiff, GitReviewSummary } from '../../../../../types/gitReview';
import { GitReviewView, type ReviewFileState } from './GitReviewView';
import type { GitSyncBarProps } from './GitSyncBar';

const CHANGES: GitChangesView = {
  branch: 'feat/git',
  base: 'origin/main',
  added: 131,
  removed: 12,
  files: 4,
  upstream: { ref: 'origin/feat/git', ahead: 2, behind: 0 },
};

const SUMMARY: GitReviewSummary = {
  repository: true,
  branch: 'feat/git',
  base: 'origin/main',
  mergeBase: '4f2a91c',
  files: [
    { path: 'src/services/gitCli/index.ts', status: 'modified', added: 40, removed: 8 },
    { path: 'src/services/gitAuth/index.ts', status: 'added', added: 80, removed: 0 },
    { path: 'src/types/webWorktrees.ts', status: 'modified', added: 11, removed: 4 },
    { path: 'README.md', status: 'untracked', added: 0, removed: 0, binary: false },
  ],
};

const GIT_CLI: GitReviewFileDiff = {
  path: 'src/services/gitCli/index.ts',
  hunks: [
    {
      start: 12,
      rows: [
        { marker: ' ', line: 12, content: "import { execFile } from 'node:child_process';" },
        { marker: '-', line: 13, content: "import fs from 'node:fs';" },
        { marker: '+', line: 13, content: "import fs from 'node:fs/promises';" },
        { marker: '+', line: 14, content: "import path from 'node:path';" },
        { marker: ' ', line: 15, content: '' },
      ],
    },
    {
      start: 41,
      rows: [
        {
          marker: ' ',
          line: 41,
          content: 'function git(cwd: string, args: readonly string[], timeout: number): Promise<GitResult> {',
        },
        {
          marker: '-',
          line: 40,
          content: "  return run(cwd, args, { timeout, env: { ...process.env, LC_ALL: 'C' } });",
        },
        { marker: '+', line: 42, content: '  return runGit(cwd, args, { timeout });' },
        { marker: ' ', line: 43, content: '}' },
      ],
    },
  ],
};

const GIT_AUTH: GitReviewFileDiff = {
  path: 'src/services/gitAuth/index.ts',
  hunks: [
    {
      start: 1,
      rows: [
        { marker: '+', line: 1, content: "import fs from 'node:fs';" },
        { marker: '+', line: 2, content: '' },
        { marker: '+', line: 3, content: 'export function createGitAuthStore(homeDir: string) {' },
        { marker: '+', line: 4, content: '  const file = credentialsFile(homeDir);' },
        { marker: '+', line: 5, content: '  return { read: () => readJson(file) };' },
        { marker: '+', line: 6, content: '}' },
      ],
    },
  ],
};

const COMMENTS: ReviewComment[] = [
  {
    id: 'c1',
    path: 'src/services/gitCli/index.ts',
    relPath: 'src/services/gitCli/index.ts',
    side: 'old',
    startLine: 13,
    endLine: 13,
    snippet: "import fs from 'node:fs';",
    body: 'Keep the sync fs import; removeWorktree still calls fs.existsSync.',
  },
  {
    id: 'c2',
    path: 'src/services/gitAuth/index.ts',
    relPath: 'src/services/gitAuth/index.ts',
    side: 'new',
    startLine: 5,
    endLine: 5,
    snippet: '  return { read: () => readJson(file) };',
    body: 'Repair loose file modes on read, like remoteAccessStore does.',
  },
];

const FILES: Record<string, ReviewFileState> = {
  'src/services/gitCli/index.ts': { state: 'ready', diff: GIT_CLI },
  'src/services/gitAuth/index.ts': { state: 'ready', diff: GIT_AUTH },
  'src/types/webWorktrees.ts': { state: 'loading' },
  'README.md': { state: 'error', error: 'The session is unreachable.' },
};

const noop = (): void => undefined;
const sync: GitSyncBarProps = {
  changes: CHANGES,
  onSync: noop,
  onForcePush: noop,
  onAskAgent: noop,
  onDismissError: noop,
};
const handlers = { onLoadFile: noop, onAddComment: noop, onRemoveComment: noop, onSendReview: noop, onDiscard: noop };

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-[1100px] flex-col gap-2">
      <span className="text-2xs text-doom-dim uppercase tracking-widest">{label}</span>
      <div className="flex h-[620px] flex-col overflow-hidden rounded-md border border-doom-border-soft bg-doom-rail">
        {children}
      </div>
    </div>
  );
}

const meta = {
  title: 'Git/GitReviewView',
  component: GitReviewView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <Frame label="two comments queued · a draft open under line 14">
        <GitReviewView
          sync={sync}
          summary={{ state: 'ready', summary: SUMMARY }}
          files={FILES}
          comments={COMMENTS}
          initialDraft={{
            path: 'src/services/gitCli/index.ts',
            selection: {
              side: 'new',
              startLine: 13,
              endLine: 14,
              snippet: "import fs from 'node:fs/promises';\nimport path from 'node:path';",
            },
          }}
          {...handlers}
        />
      </Frame>
    </div>
  ),
};

export const States = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <Frame label="send failed · comments kept">
        <GitReviewView
          sync={sync}
          summary={{ state: 'ready', summary: SUMMARY }}
          files={FILES}
          comments={COMMENTS}
          sendError="The session protocol is not connected."
          {...handlers}
        />
      </Frame>
      <Frame label="no changes">
        <GitReviewView
          sync={{ ...sync, changes: { ...CHANGES, added: 0, removed: 0, files: 0 } }}
          summary={{ state: 'ready', summary: { ...SUMMARY, files: [] } }}
          files={{}}
          comments={[]}
          {...handlers}
        />
      </Frame>
      <Frame label="reading changes">
        <GitReviewView sync={sync} summary={{ state: 'loading' }} files={{}} comments={[]} {...handlers} />
      </Frame>
    </div>
  ),
};
