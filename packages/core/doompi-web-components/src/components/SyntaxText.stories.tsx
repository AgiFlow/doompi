import { SyntaxLine, SyntaxText } from './SyntaxText.tsx';

const TYPESCRIPT = [
  'export function label(session: Session): string {',
  '  // the id is the fallback name',
  '  return session.title ?? session.id;',
  '}',
].join('\n');

const SPANS = [
  { text: 'const ', token: 'keyword' },
  { text: 'ready', token: 'variable' },
  { text: ' = ', token: 'operator' },
  { text: 'true', token: 'constant' },
  { text: ';', token: 'punctuation' },
] as const;

const meta = {
  title: 'Components/SyntaxText',
  component: SyntaxText,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">grammar given</span>
        <SyntaxText text={TYPESCRIPT} grammar="typescript" className="text-sm text-doom-text" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">grammar from the path</span>
        <SyntaxText text={TYPESCRIPT} path="src/label.ts" className="text-sm text-doom-text" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">no grammar, plain</span>
        <SyntaxText text={TYPESCRIPT} className="text-sm text-doom-text" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">SyntaxLine</span>
        <div className="flex flex-col font-mono text-sm text-doom-text">
          <SyntaxLine spans={SPANS} text="" />
          <SyntaxLine text="const ready = true; // no spans yet, so plain" />
        </div>
      </div>
    </div>
  ),
};
