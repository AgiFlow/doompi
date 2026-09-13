/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { EditToolMessage } from './EditToolMessage';

// Pi's display diff: `+12 text`, `-12 text`, ` 12 text`, and an unnumbered
// elision between hunks.
const DIFF = [
  ' 1 import { clsx, type ClassValue } from "clsx";',
  ' 2 import { twMerge } from "tailwind-merge";',
  ' ... ',
  ' 5 export function cn(...inputs: ClassValue[]) {',
  '-6   return twMerge(clsx(inputs));',
  '+6   return twMerge(clsx(inputs), { cache: true });',
  ' 7 }',
].join('\n');

const LONG_DIFF = Array.from({ length: 30 }, (_, index) => `+${String(index + 1)} const row = ${String(index)};`).join(
  '\n',
);

const args = { path: 'src/lib/cn.ts', edits: [{ from: '5#usq', to: '6#eky' }] };

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'edit', ...overrides }).props;

const meta = {
  title: 'Edit/EditToolMessage',
  component: EditToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <EditToolMessage {...props({ args, running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · banded diff rows</span>
        <EditToolMessage {...props({ args, result: { content: [], details: { diff: DIFF } } })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · collapsed past 24 rows</span>
        <EditToolMessage
          {...props({
            args: { path: 'src/lib/rows.ts', edits: [{ from: '1#aaa', to: '30#zzz' }] },
            result: { content: [], details: { diff: LONG_DIFF } },
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <EditToolMessage
          {...props({
            args: { path: 'src/lib/cn.ts', edits: [{ from: '5#usq', to: '6#eky' }] },
            result: { content: [{ type: 'text', text: 'anchor 5#usq no longer matches the file' }], details: null },
            output: 'anchor 5#usq no longer matches the file',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
