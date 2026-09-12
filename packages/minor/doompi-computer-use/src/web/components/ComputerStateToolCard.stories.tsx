/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { ComputerStateToolCard } from './ComputerStateToolCard';
import { computerStateToolName } from '../lib/computerStateToolRender';

const props = (overrides: Parameters<typeof toolMessagePropsFixture>[0]) => toolMessagePropsFixture(overrides).props;

const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: null });

const TREE = text(
  [
    'window "Reports — Acme" frontmost',
    'toolbar',
    '  button:Save enabled',
    '  button:Publish disabled',
    'sidebar list · 4 rows',
    '  row 1 "Q1" selected',
    '  row 2 "Q2"',
    '  row 3 "Q3"',
    '  row 4 "Q4"',
    'status "saved 14:32"',
  ].join('\n'),
);

const meta = {
  title: 'ComputerUse/ComputerStateToolCard',
  component: ComputerStateToolCard,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <ComputerStateToolCard {...props({ toolName: computerStateToolName, args: {}, running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete</span>
        <ComputerStateToolCard
          {...props({
            toolName: computerStateToolName,
            args: {},
            result: text('window "Reports — Acme" frontmost · no dialog open'),
            output: 'window "Reports — Acme" frontmost · no dialog open',
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · collapsed with more lines</span>
        <ComputerStateToolCard {...props({ toolName: computerStateToolName, args: {}, result: TREE })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <ComputerStateToolCard
          {...props({
            toolName: computerStateToolName,
            args: {},
            result: text('no window is authorized for computer use'),
            output: 'no window is authorized for computer use',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
