/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import { CommentDraft } from './CommentDraft';

const SNIPPET = [
  'export function cn(...inputs: ClassValue[]) {',
  '  const merged = twMerge(clsx(inputs));',
  '  return merged;',
  '}',
].join('\n');

const LONG_SNIPPET = Array.from({ length: 14 }, (_, index) => `  line ${index + 1} of a selection past the trim`).join(
  '\n',
);

const noop = (): void => {};

const meta = {
  title: 'Files/CommentDraft',
  component: CommentDraft,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">a line range</span>
        <CommentDraft snippet={SNIPPET} startLine={12} endLine={15} onSubmit={noop} onCancel={noop} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">a single line</span>
        <CommentDraft snippet="  return merged;" startLine={14} onSubmit={noop} onCancel={noop} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          no anchor · selected in the rendered preview
        </span>
        <CommentDraft
          snippet="The cockpit serves any file under a session's working directory."
          onSubmit={noop}
          onCancel={noop}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">long selection · trimmed and scrolled</span>
        <CommentDraft snippet={LONG_SNIPPET} startLine={40} endLine={53} onSubmit={noop} onCancel={noop} />
      </div>
    </div>
  ),
};
