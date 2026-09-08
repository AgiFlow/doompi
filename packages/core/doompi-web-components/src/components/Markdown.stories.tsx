import { Markdown } from './Markdown.tsx';

const DOC = [
  '## Release notes',
  '',
  '**Ships today:** the `--watch` flag, plus a [changelog](https://example.com).',
  '',
  '- pty output streams again',
  '- `src/app.ts` reloads in place',
  '',
  '```ts',
  "export const version = '2.1.0';",
  '```',
].join('\n');

const meta = {
  title: 'Components/Markdown',
  component: Markdown,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">document</span>
        <Markdown text={DOC} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">with file links</span>
        <Markdown text={DOC} onFileLink={(text) => (text.endsWith('.ts') ? () => undefined : undefined)} />
      </div>
    </div>
  ),
};
