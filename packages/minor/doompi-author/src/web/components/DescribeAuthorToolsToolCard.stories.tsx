/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. Props come from the contracts package's own
 * testing fixture rather than a hand-rolled stub, so a change to the tool
 * message contract breaks this story at the type level.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { DescribeAuthorToolsToolCard } from './DescribeAuthorToolsToolCard';

const SHORT = ['author viewport tools', '- annotate_region', '- revise_fragment'].join('\n');

const LONG = Array.from({ length: 12 }, (_, index) => `- tool_${String(index + 1).padStart(2, '0')}`).join('\n');

const textResult = (text: string) => ({ content: [{ type: 'text', text }], details: null });

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'describe_author_tools', ...overrides }).props;

const meta = {
  title: 'Author/DescribeAuthorToolsToolCard',
  component: DescribeAuthorToolsToolCard,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <DescribeAuthorToolsToolCard {...props({ running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete</span>
        <DescribeAuthorToolsToolCard {...props({ result: textResult(SHORT), output: SHORT })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · collapsed past eight lines</span>
        <DescribeAuthorToolsToolCard {...props({ result: textResult(LONG), output: LONG })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <DescribeAuthorToolsToolCard
          {...props({
            result: textResult('No Author viewport is focused.'),
            output: 'No Author viewport is focused.',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
