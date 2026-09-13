/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';

import { ReadToolMessage } from './ReadToolMessage';

const OUTPUT = [
  '@file src/lib/cn.ts#a1b2c3d4',
  "1#axh|import { clsx, type ClassValue } from 'clsx';",
  "2#zyb|import { twMerge } from 'tailwind-merge';",
  '3#rew|',
  '4#nsj|export function cn(...inputs: ClassValue[]) {',
  '5#usq|  return twMerge(clsx(inputs));',
  '6#eky|}',
].join('\n');

const result = { content: [{ type: 'text', text: OUTPUT }], details: null };

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'read', ...overrides }).props;

const meta = {
  title: 'Read/ReadToolMessage',
  component: ReadToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <ReadToolMessage {...props({ args: { path: 'src/lib/cn.ts' }, running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete</span>
        <ReadToolMessage {...props({ args: { path: 'src/lib/cn.ts' }, result, output: OUTPUT })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          complete · offset and limit in the heading
        </span>
        <ReadToolMessage {...props({ args: { path: 'src/lib/cn.ts', offset: 1, limit: 6 }, result, output: OUTPUT })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <ReadToolMessage
          {...props({
            args: { path: 'src/lib/missing.ts' },
            result: { content: [{ type: 'text', text: 'ENOENT: no such file or directory' }], details: null },
            output: 'ENOENT: no such file or directory',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
