/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`. The card reads the opened path out of
 * `result.details.path`, so the "ready" state needs details, not just text.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { OpenAuthoringFileToolCard } from './OpenAuthoringFileToolCard.tsx';

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'open_authoring_file', ...overrides }).props;

const meta = {
  title: 'Author/OpenAuthoringFileToolCard',
  component: OpenAuthoringFileToolCard,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running · validating</span>
        <OpenAuthoringFileToolCard {...props({ args: { path: 'docs/spec.md' }, running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · no path in details</span>
        <OpenAuthoringFileToolCard
          {...props({ args: { path: 'docs/spec.md' }, result: { content: [], details: null } })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · ready to open</span>
        <OpenAuthoringFileToolCard
          {...props({
            args: { path: 'docs/spec.md' },
            result: { content: [], details: { path: 'docs/spec.md' } },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <OpenAuthoringFileToolCard
          {...props({
            args: { path: 'docs/missing.md' },
            result: { content: [{ type: 'text', text: 'ENOENT: no such file or directory' }], details: null },
            output: 'ENOENT: no such file or directory',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
