import { CodeBlock } from './CodeBlock.tsx';

const TYPESCRIPT = [
  'export function label(session: Session): string {',
  '  // the id is the fallback name',
  '  return session.title ?? session.id;',
  '}',
].join('\n');

const PLAIN = ['no fence language, so no grammar', 'and the block stays plain text'].join('\n');

const MERMAID = 'graph TD; A-->B;';

const meta = {
  title: 'Components/CodeBlock',
  component: CodeBlock,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">language-typescript</span>
        <CodeBlock text={TYPESCRIPT} className="language-typescript" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">bare fence</span>
        <CodeBlock text={PLAIN} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">language-mermaid</span>
        <CodeBlock text={MERMAID} className="language-mermaid" />
      </div>
    </div>
  ),
};
