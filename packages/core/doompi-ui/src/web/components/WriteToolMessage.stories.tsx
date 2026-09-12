/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the tool contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';
import { WriteToolMessage } from './WriteToolMessage';

/** Past the ten-line collapsed budget, so the preview reports what it hid. */
const CONTENT = [
  "import { clsx, type ClassValue } from 'clsx';",
  "import { twMerge } from 'tailwind-merge';",
  '',
  '/** The one class merger every component uses. */',
  'export function cn(...inputs: ClassValue[]) {',
  '  return twMerge(clsx(inputs));',
  '}',
  '',
  'export function cx(...inputs: ClassValue[]) {',
  '  return clsx(inputs);',
  '}',
  '',
  'export const noop = () => undefined;',
].join('\n');

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'write', ...overrides }).props;

const args = { path: 'src/lib/cn.ts', content: CONTENT };

const meta = {
  title: 'Ui/WriteToolMessage',
  component: WriteToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running · preview so far</span>
        <WriteToolMessage {...props({ args, running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · ten of thirteen lines</span>
        <WriteToolMessage {...props({ args, result: { content: [], details: null } })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · path opens a tab</span>
        <WriteToolMessage
          {...props({
            args,
            result: { content: [], details: null },
            fileTab: (path) => ({ id: `file-${path}`, label: path, panel: () => null }),
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <WriteToolMessage
          {...props({
            args,
            result: { content: [{ type: 'text', text: 'EACCES: permission denied' }], details: null },
            output: 'EACCES: permission denied',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
