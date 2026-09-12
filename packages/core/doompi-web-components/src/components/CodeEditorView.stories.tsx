import { CodeEditorView } from './CodeEditorView';

const CODE = [
  "import { cn } from './cn.ts';",
  '',
  'export function label(name: string): string {',
  "  return cn('doom', name);",
  '}',
].join('\n');

const PATH = 'src/label.ts';

const meta = {
  title: 'Components/CodeEditorView',
  component: CodeEditorView,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">editable</span>
        <CodeEditorView value={CODE} path={PATH} className="h-40" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">read only</span>
        <CodeEditorView value={CODE} path={PATH} readOnly className="h-40" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">no wrapping, plain text</span>
        <CodeEditorView value={CODE} lineWrapping={false} className="h-40" />
      </div>
    </div>
  ),
};
