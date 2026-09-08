/*
 * Plain CSF objects: the style-system renderer parses this file statically and
 * mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { ComputerExecToolCard } from './ComputerExecToolCard.tsx';
import { computerExecToolName } from '../lib/computerExecToolRender.ts';

const props = (overrides: Parameters<typeof toolMessagePropsFixture>[0]) => toolMessagePropsFixture(overrides).props;

const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: null });

const LONG = text(
  [
    'running scripts/export-report.scpt',
    'opened the authorized window',
    'selected the report tab',
    'set the range to last 30 days',
    'triggered the export',
    'waited for the sheet to close',
    'wrote ~/Downloads/report.csv',
    'checksum 4f1c9ab2',
    'exit status 0',
    'elapsed 3.4s',
  ].join('\n'),
);

const meta = {
  title: 'ComputerUse/ComputerExecToolCard',
  component: ComputerExecToolCard,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <ComputerExecToolCard
          {...props({
            toolName: computerExecToolName,
            args: { scriptPath: 'scripts/export-report.scpt' },
            running: true,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete</span>
        <ComputerExecToolCard
          {...props({
            toolName: computerExecToolName,
            args: { scriptPath: 'scripts/export-report.scpt' },
            result: text('exit status 0 · wrote ~/Downloads/report.csv'),
            output: 'exit status 0 · wrote ~/Downloads/report.csv',
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · collapsed with more lines</span>
        <ComputerExecToolCard
          {...props({
            toolName: computerExecToolName,
            args: { scriptPath: 'scripts/export-report.scpt' },
            result: LONG,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <ComputerExecToolCard
          {...props({
            toolName: computerExecToolName,
            args: { scriptPath: 'scripts/unsigned.scpt' },
            result: text('the script is outside the authorized script directory'),
            output: 'the script is outside the authorized script directory',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
