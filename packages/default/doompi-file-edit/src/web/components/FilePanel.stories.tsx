/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * The panel fetches its own history on mount, so the story answers the detail
 * route instead of pre-seeding the store: that is the state the panel actually
 * reaches, error line and all, rather than one assembled behind its back. The
 * diff and edit views are entered by clicking, which a static render cannot do,
 * so what is covered here is the preview the tab opens on.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { FileEditsDetailView } from '../../types/fileEditsApi.ts';
import { FilePanel } from './FilePanel.tsx';

const AT = Date.parse('2024-05-04T10:00:00Z');

const CODE = [
  "import { clsx, type ClassValue } from 'clsx';",
  "import { twMerge } from 'tailwind-merge';",
  '',
  'export function cn(...inputs: ClassValue[]) {',
  '  const merged = twMerge(clsx(inputs));',
  '  return merged;',
  '}',
].join('\n');

const MARKDOWN = [
  '# doompi-file-edit',
  '',
  'Every file this session changed, with its history and a way to fix a line.',
  '',
  '- `detail` answers one file in a single round trip',
  '- `content` takes the manual save back',
  '- `preview` reads a file the session never changed',
].join('\n');

function detailOf(relPath: string, overrides: Partial<FileEditsDetailView> = {}): FileEditsDetailView {
  return {
    path: `/Users/dev/project/${relPath}`,
    relPath,
    versions: [
      { index: 1, tool: 'write', at: AT, origin: 'tool', additions: 7, removals: 0 },
      { index: 2, tool: 'edit', at: AT + 60_000, origin: 'tool', additions: 2, removals: 1 },
    ],
    cumulative: { additions: 9, removals: 1 },
    working: { content: CODE, hash: 'a1b2c3d4', unavailable: false },
    ...overrides,
  };
}

const DETAILS: Record<string, FileEditsDetailView | undefined> = {
  '/Users/dev/project/src/web/lib/cn.ts': detailOf('src/web/lib/cn.ts'),
  '/Users/dev/project/README.md': detailOf('README.md', {
    working: { content: MARKDOWN, hash: 'e5f6a7b8', unavailable: false },
  }),
  '/Users/dev/project/src/data/index.bin': detailOf('src/data/index.bin', {
    cumulative: { additions: 0, removals: 0, note: 'no baseline was captured for this file' },
    working: {
      content: '',
      hash: '',
      unavailable: true,
      reason: 'this file is binary, so its text was not captured',
    },
  }),
};

/**
 * The session API, answered in the page. `sealedTransport.fetch` is a
 * pass-through off a tunnel, so replacing the global is the one seam that
 * covers every route the panel reaches; anything unrecognised falls through to
 * the real one so the renderer's own requests still work.
 */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  const filePath = new URL(url, globalThis.location.origin).searchParams.get('path') ?? '';
  const detail = DETAILS[filePath];
  if (url.includes('/api/plugin/file-edits/detail') && detail !== undefined) {
    return Promise.resolve(new Response(JSON.stringify(detail), { status: 200 }));
  }
  if (url.includes('/api/sessions/')) {
    return Promise.resolve(new Response(new Blob(['\u0000\u0001binary'], { type: 'application/octet-stream' })));
  }
  return realFetch(input, init);
};

const slot = slotPropsFixture({ sessionId: 's1' }).props;

const meta = {
  title: 'Files/FilePanel',
  component: FilePanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">code · preview holds the editor open</span>
        <div className="flex h-96 flex-col border border-doom-border-soft">
          <FilePanel {...slot} filePath="/Users/dev/project/src/web/lib/cn.ts" relPath="src/web/lib/cn.ts" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">markdown · rendered, not diffed</span>
        <div className="flex h-96 flex-col border border-doom-border-soft">
          <FilePanel {...slot} filePath="/Users/dev/project/README.md" relPath="README.md" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          binary · the reason is said and the bytes are offered anyway
        </span>
        <div className="flex h-96 flex-col border border-doom-border-soft">
          <FilePanel {...slot} filePath="/Users/dev/project/src/data/index.bin" relPath="src/data/index.bin" />
        </div>
      </div>
    </div>
  ),
};
