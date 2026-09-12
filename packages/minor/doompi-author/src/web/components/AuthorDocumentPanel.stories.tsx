/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The panel loads the document over HTTP when
 * the store has none, so each variant seeds the store first and only the
 * inactive-mode branch is left to the fallback path.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import type { AuthorDocumentInput } from '../lib/authorViewportTypes';
import { putAuthorDocument, reviseAuthorDocument } from '../stores/authorWorkspaceStore';
import { AuthorDocumentPanel } from './AuthorDocumentPanel';

const SPEC: AuthorDocumentInput = {
  path: 'docs/spec.md',
  kind: 'markdown',
  title: 'Gateway spec',
  content: '# Gateway retries\n\nThe gateway retries three times before giving up.\n\n- immediate\n- backed off',
  sourceSha256: 'abc123',
};

const NOTES: AuthorDocumentInput = {
  path: 'docs/notes.txt',
  kind: 'text',
  content: 'retry budget: 3\nbackoff: 2s\n',
  sourceSha256: 'def456',
};

putAuthorDocument('doc-preview', SPEC);
putAuthorDocument('doc-dirty', NOTES);
reviseAuthorDocument('doc-dirty', NOTES.path, 'retry budget: 5\nbackoff: 2s\n');

function props(sessionId: string, activeMinorModes: readonly string[]): WebPluginSlotProps {
  return { ...slotPropsFixture({ sessionId }).props, activeMinorModes };
}

const meta = {
  title: 'Author/AuthorDocumentPanel',
  component: AuthorDocumentPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex h-64 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">markdown · preview</span>
        <AuthorDocumentPanel {...props('doc-preview', ['author'])} path={SPEC.path} />
      </div>

      <div className="flex h-64 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">text · unsaved revision, save enabled</span>
        <AuthorDocumentPanel {...props('doc-dirty', ['author'])} path={NOTES.path} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">author mode off · no file viewer</span>
        <AuthorDocumentPanel {...props('doc-preview', [])} path={SPEC.path} />
      </div>
    </div>
  ),
};
