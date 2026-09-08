/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The palette branches on the document kind
 * (markdown adds the formatting tools) and on the active tool.
 */
import { AuthorToolPalette } from './AuthorToolPalette.tsx';

const meta = {
  title: 'Author/AuthorToolPalette',
  component: AuthorToolPalette,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">markdown · select</span>
        <AuthorToolPalette sessionId="s1" kind="markdown" activeTool="select" />
      </div>

      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">markdown · marking a region</span>
        <AuthorToolPalette sessionId="s1" kind="markdown" activeTool="mark" />
      </div>

      <div className="flex w-80 flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">image · no formatting tools</span>
        <AuthorToolPalette sessionId="s1" kind="image" activeTool="select" />
      </div>
    </div>
  ),
};
