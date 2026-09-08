/*
 * Plain CSF objects; see Badge.stories.tsx for why Storybook's types are not
 * imported. The tone row is generated from MESSAGE_LINE_TONES, so a tone added
 * to the vocabulary shows up here without an edit.
 */
import { MESSAGE_LINE_TONES } from '../types/tone.ts';
import { type MessageLine, MessageLines } from './MessageLines.tsx';

const TONES: readonly MessageLine[] = MESSAGE_LINE_TONES.map((tone) => ({
  text: `${tone} · the quick brown fox jumps`,
  tone,
}));

const EMPHASIS: readonly MessageLine[] = [
  { text: 'bold', tone: 'hi', bold: true },
  { text: 'plain', tone: 'hi' },
  { text: 'indented', tone: 'dim', indent: true },
  { text: 'bold and indented', tone: 'dim', bold: true, indent: true },
];

const BODY: readonly MessageLine[] = [
  { text: 'pnpm test doompi-web-components', tone: 'hi', bold: true },
  { text: '3 files changed', tone: 'text' },
  { text: 'src/components/MessageLines.tsx', tone: 'dim', indent: true },
  { text: 'src/types/tone.ts', tone: 'dim', indent: true },
  { text: '42 passed', tone: 'success' },
  { text: '1 flaky', tone: 'warning' },
  { text: '1 failed', tone: 'error', bold: true },
  { text: 'rerun with --reporter=verbose', tone: 'muted' },
];

const meta = {
  title: 'Components/MessageLines',
  component: MessageLines,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">tone · every line tone</span>
        <MessageLines className="text-sm" lines={TONES} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">bold and indent</span>
        <MessageLines className="text-sm" lines={EMPHASIS} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">body · a tool result</span>
        <MessageLines className="text-sm" lines={BODY} />
      </div>
    </div>
  ),
};
