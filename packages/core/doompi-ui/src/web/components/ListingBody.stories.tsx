/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the tool contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { ListingBody } from './ListingBody';

/** Past the twenty-line collapsed budget, so the collapsed body reports what it hid. */
const ENTRIES = Array.from({ length: 26 }, (_, index) => `src/web/components/Panel${String(index + 1)}.tsx`).join('\n');

const result = (details: unknown = null) => ({ content: [{ type: 'text', text: ENTRIES }], details });

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'ls', args: { path: 'src/web' }, ...overrides }).props;

const body = { tool: 'ls', limitKey: 'entryLimitReached', limitUnit: 'entries' };

const meta = {
  title: 'Ui/ListingBody',
  component: ListingBody,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <ListingBody {...body} expanded={false} props={props({ running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">collapsed · twenty of twenty-six</span>
        <ListingBody {...body} expanded={false} props={props({ result: result(), output: ENTRIES })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">collapsed · entry limit reached</span>
        <ListingBody
          {...body}
          expanded={false}
          props={props({ result: result({ entryLimitReached: 26 }), output: ENTRIES })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <ListingBody
          {...body}
          expanded={false}
          props={props({
            result: { content: [{ type: 'text', text: 'ENOENT: no such directory' }], details: null },
            output: 'ENOENT: no such directory',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
