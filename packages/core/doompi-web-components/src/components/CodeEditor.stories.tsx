import { CodeEditor } from './CodeEditor';

const CODE = [
  "import { cn } from './cn.ts';",
  '',
  'export function label(name: string): string {',
  "  return cn('doom', name);",
  '}',
].join('\n');

const PATH = 'src/label.ts';

const meta = {
  title: 'Components/CodeEditor',
  component: CodeEditor,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">editable</span>
        <CodeEditor value={CODE} path={PATH} className="h-40" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">read only</span>
        <CodeEditor value={CODE} path={PATH} readOnly className="h-40" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">no wrapping, plain text</span>
        <CodeEditor value={CODE} lineWrapping={false} className="h-40" />
      </div>
    </div>
  ),
};
