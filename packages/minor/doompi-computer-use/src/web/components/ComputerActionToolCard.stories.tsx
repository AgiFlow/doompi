/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { ComputerActionToolCard } from './ComputerActionToolCard.tsx';
import { computerActionToolName } from '../lib/computerActionToolRender.ts';

const props = (overrides: Parameters<typeof toolMessagePropsFixture>[0]) => toolMessagePropsFixture(overrides).props;

const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: null });

const LONG = text(
  [
    'clicked Save in the authorized window',
    'focus moved to the document body',
    'a toast appeared: Draft saved',
    'the title bar lost its modified marker',
    'the sidebar list refreshed',
    'row 3 became selected',
    'the status strip read: saved 14:32',
    'no dialog is open',
    'the window remained frontmost',
    'no further actions are pending',
  ].join('\n'),
);

const meta = {
  title: 'ComputerUse/ComputerActionToolCard',
  component: ComputerActionToolCard,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <ComputerActionToolCard
          {...props({
            toolName: computerActionToolName,
            args: { kind: 'click', elementRef: 'button:Save' },
            running: true,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete</span>
        <ComputerActionToolCard
          {...props({
            toolName: computerActionToolName,
            args: { kind: 'click', elementRef: 'button:Save' },
            result: text('clicked Save in the authorized window'),
            output: 'clicked Save in the authorized window',
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · collapsed with more lines</span>
        <ComputerActionToolCard
          {...props({
            toolName: computerActionToolName,
            args: { kind: 'type', elementRef: 'textbox:Search' },
            result: LONG,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <ComputerActionToolCard
          {...props({
            toolName: computerActionToolName,
            args: { kind: 'click', elementRef: 'button:Publish' },
            result: text('the element is not in the authorized window'),
            output: 'the element is not in the authorized window',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
