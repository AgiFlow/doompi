/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * looking for a bare `const meta`, so the export is not named at the point of
 * definition. The props come from the contracts package's own testing fixture
 * rather than a hand-rolled stub, so a change to the tool contract breaks this
 * story at the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { FindToolMessage } from './FindToolMessage.tsx';

const MATCHES = [
  'src/web/components/FindToolMessage.tsx:10:export function FindToolMessage(props',
  'src/web/components/LsToolMessage.tsx:10:export function LsToolMessage(props',
  'src/web/components/ListingBody.tsx:9:export function ListingBody({',
  'src/web/components/WriteToolMessage.tsx:47:export function WriteToolMessage({',
  'src/web/lib/builtinToolView.ts:57:export function writeCallView(args',
  'src/web/lib/builtinToolView.ts:70:export function findCallView(args',
].join('\n');

const result = (details: unknown = null) => ({ content: [{ type: 'text', text: MATCHES }], details });

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'find', ...overrides }).props;

const args = { pattern: 'export function', path: 'src/web' };

const meta = {
  title: 'Ui/FindToolMessage',
  component: FindToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">running</span>
        <FindToolMessage {...props({ args, running: true })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete</span>
        <FindToolMessage {...props({ args, result: result(), output: MATCHES })} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · result limit reached</span>
        <FindToolMessage
          {...props({
            args: { ...args, limit: 6 },
            result: result({ resultLimitReached: 6 }),
            output: MATCHES,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <FindToolMessage
          {...props({
            args: { pattern: '[unclosed', path: 'src/web' },
            result: { content: [{ type: 'text', text: 'invalid regex: missing ]' }], details: null },
            output: 'invalid regex: missing ]',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
