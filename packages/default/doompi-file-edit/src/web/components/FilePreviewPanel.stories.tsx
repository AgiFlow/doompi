/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 *
 * The panel has no store: everything it shows comes from one fetch, so the
 * story answers the preview route and each variant is a different file.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';

import type { FileEditsPreviewView } from '../../types/fileEditsApi';
import { FilePreviewPanel } from './FilePreviewPanel';

const CODE = [
  "export const filesChannelType = 'file_edits';",
  '',
  '/** Footer status key whose presence shows the activity group. */',
  "export const filesStatusKey = 'doom-file-edit-files';",
].join('\n');

const MARKDOWN = [
  '## reading a file the session never changed',
  '',
  'One view, the file as it stands, and nothing else.',
].join('\n');

function previewOf(relPath: string, content: string): FileEditsPreviewView {
  return {
    path: `/Users/dev/project/${relPath}`,
    relPath,
    working: { content, hash: 'c0ffee', unavailable: false },
  };
}

const PREVIEWS: Record<string, FileEditsPreviewView | undefined> = {
  '/Users/dev/project/src/types/webFiles.ts': previewOf('src/types/webFiles.ts', CODE),
  '/Users/dev/project/NOTES.md': previewOf('NOTES.md', MARKDOWN),
};

/** Never settles, so the panel stays on its loading line for the shot. */
const PENDING_PATH = '/Users/dev/project/src/slow.ts';

/**
 * The session API, answered in the page. `sealedTransport.fetch` is a
 * pass-through off a tunnel, so replacing the global covers the route the panel
 * reaches; anything unrecognised falls through to the real one.
 */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes('/api/plugin/file-edits/preview')) return realFetch(input, init);
  const filePath = new URL(url, globalThis.location.origin).searchParams.get('path') ?? '';
  if (filePath === PENDING_PATH) return new Promise<Response>(() => {});
  const preview = PREVIEWS[filePath];
  if (preview === undefined) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: 'that path is outside the session working directory' }), { status: 403 }),
    );
  }
  return Promise.resolve(new Response(JSON.stringify(preview), { status: 200 }));
};

const slot = slotPropsFixture({ sessionId: 's1' }).props;

const meta = {
  title: 'Files/FilePreviewPanel',
  component: FilePreviewPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">code · read-only, marked unchanged</span>
        <div className="flex h-96 flex-col border border-doom-border-soft">
          <FilePreviewPanel {...slot} filePath="/Users/dev/project/src/types/webFiles.ts" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">markdown · rendered</span>
        <div className="flex h-64 flex-col border border-doom-border-soft">
          <FilePreviewPanel {...slot} filePath="/Users/dev/project/NOTES.md" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">still reading</span>
        <div className="flex flex-col border border-doom-border-soft">
          <FilePreviewPanel {...slot} filePath={PENDING_PATH} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">the route refused</span>
        <div className="flex flex-col border border-doom-border-soft">
          <FilePreviewPanel {...slot} filePath="/etc/passwd" />
        </div>
      </div>
    </div>
  ),
};
