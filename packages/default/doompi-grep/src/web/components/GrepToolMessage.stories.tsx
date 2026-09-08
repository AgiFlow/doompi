/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the slot contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { GrepToolMessage } from './GrepToolMessage.tsx';

const MATCHES = [
  '@file src/lib/cn.ts#a1b2c3d4',
  '   3#rew|',
  '>> 4#nsj|export function cn(...inputs: ClassValue[]) {',
  '   5#usq|  return twMerge(clsx(inputs));',
  '@file src/lib/theme.ts#9f8e7d6c',
  '>> 12#pqr|export function cnTheme(name: string) {',
  '[2 matches in 2 files]',
].join('\n');

const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: null });

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'grep', ...overrides }).props;

/*
 * The card is collapsed until someone clicks it and the renderer only takes a
 * screenshot, so every result body here would be invisible. Opening the card
 * from a mount ref is what puts the body in the shot; the collapsed header is
 * shown once on its own so both states are reviewable.
 */
const openCard = (node: HTMLDivElement | null) =>
  node?.querySelector<HTMLButtonElement>('[data-testid="tool-expand"]')?.click();

const meta = {
  title: 'Grep/GrepToolMessage',
  component: GrepToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">collapsed · the default</span>
        <GrepToolMessage
          {...props({ args: { pattern: 'export function cn', path: 'src/lib' }, result: text(MATCHES) })}
        />
      </div>

      <div className="flex flex-col gap-2" ref={openCard}>
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <GrepToolMessage {...props({ args: { pattern: 'export function cn' }, running: true })} />
      </div>

      <div className="flex flex-col gap-2" ref={openCard}>
        <span className="text-2xs text-doom-dim uppercase tracking-widest">expanded · matches and context</span>
        <GrepToolMessage
          {...props({
            args: { pattern: 'export function cn', path: 'src/lib', glob: '*.ts', ignoreCase: true, limit: 20 },
            result: text(MATCHES),
          })}
        />
      </div>

      <div className="flex flex-col gap-2" ref={openCard}>
        <span className="text-2xs text-doom-dim uppercase tracking-widest">expanded · nothing found</span>
        <GrepToolMessage {...props({ args: { pattern: 'zzzz', path: 'src' }, result: text('[no matches]') })} />
      </div>

      <div className="flex flex-col gap-2" ref={openCard}>
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <GrepToolMessage
          {...props({
            args: { pattern: '(unclosed' },
            result: text('regex parse error: unclosed group'),
            output: 'regex parse error: unclosed group',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
