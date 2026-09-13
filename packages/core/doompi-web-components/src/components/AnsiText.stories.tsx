import { AnsiLine, AnsiText } from './AnsiText';

const LOG = [
  '\u001B[32mPASS\u001B[0m src/app.test.ts \u001B[2m12 tests\u001B[0m',
  '\u001B[33mWARN\u001B[0m unused import in \u001B[36msrc/lib/cn.ts\u001B[0m',
  '\u001B[31mFAIL\u001B[0m \u001B[1;35mtimeout\u001B[0m after 30s',
].join('\n');

const ATTRIBUTES =
  '\u001B[1mbold\u001B[0m \u001B[2mfaint\u001B[0m \u001B[3mitalic\u001B[0m \u001B[4munderline\u001B[0m \u001B[7minverse\u001B[0m \u001B[38;5;208m256 colour\u001B[0m';

const meta = {
  title: 'Components/AnsiText',
  component: AnsiText,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">block</span>
        <AnsiText text={LOG} className="font-mono text-sm text-doom-text" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">attributes</span>
        <AnsiText text={ATTRIBUTES} className="font-mono text-sm text-doom-text" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-faint uppercase tracking-widest">line by line</span>
        <div className="flex flex-col font-mono text-sm text-doom-text">
          {LOG.split('\n').map((line, index) => (
            <AnsiLine key={index} line={line} />
          ))}
        </div>
      </div>
    </div>
  ),
};
