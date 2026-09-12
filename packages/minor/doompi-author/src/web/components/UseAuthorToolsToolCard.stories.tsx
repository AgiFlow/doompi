/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. Props come from the contracts package's own
 * testing fixture rather than a hand-rolled stub.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';
import { UseAuthorToolsToolCard } from './UseAuthorToolsToolCard';

const SHORT = ['applied revision to docs/spec.md', 'fragment slide2 updated'].join('\n');

const LONG = Array.from({ length: 11 }, (_, index) => `applied change ${index + 1} of 11`).join('\n');

const textResult = (text: string) => ({ content: [{ type: 'text', text }], details: null });

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'use_author_tools', ...overrides }).props;

const meta = {
  title: 'Author/UseAuthorToolsToolCard',
  component: UseAuthorToolsToolCard,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running · name in the header</span>
        <UseAuthorToolsToolCard {...props({ args: { name: 'revise_fragment' }, running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete</span>
        <UseAuthorToolsToolCard
          {...props({ args: { name: 'revise_fragment' }, result: textResult(SHORT), output: SHORT })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · collapsed past eight lines</span>
        <UseAuthorToolsToolCard {...props({ args: { name: 'apply_batch' }, result: textResult(LONG), output: LONG })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <UseAuthorToolsToolCard
          {...props({
            args: { name: 'revise_fragment' },
            result: textResult('Unknown Author capability: revise_fragment'),
            output: 'Unknown Author capability: revise_fragment',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
