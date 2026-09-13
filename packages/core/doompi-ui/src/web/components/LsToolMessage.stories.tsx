/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the tool contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { LsToolMessage } from './LsToolMessage';

const ENTRIES = ['components/', 'lib/', 'stores/', 'index.ts', 'plugin.ts', 'toolRenderers.ts'].join('\n');

const result = (details: unknown = null) => ({ content: [{ type: 'text', text: ENTRIES }], details });

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'ls', ...overrides }).props;

const args = { path: 'src/web' };

const meta = {
  title: 'Ui/LsToolMessage',
  component: LsToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <LsToolMessage {...props({ args, running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete</span>
        <LsToolMessage {...props({ args, result: result(), output: ENTRIES })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · entry limit reached</span>
        <LsToolMessage
          {...props({
            args: { ...args, limit: 6 },
            result: result({ entryLimitReached: 6 }),
            output: ENTRIES,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <LsToolMessage
          {...props({
            args: { path: 'src/nowhere' },
            result: { content: [{ type: 'text', text: 'ENOENT: no such directory' }], details: null },
            output: 'ENOENT: no such directory',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
