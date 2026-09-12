/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`. The props come from the contracts
 * package's own testing fixture rather than a hand-rolled stub, so a change to
 * the slot contract breaks this story at the type level.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';
import { IntercomToolMessage } from './IntercomToolMessage';

const props = (overrides: Omit<Parameters<typeof toolMessagePropsFixture>[0], 'toolName'>) =>
  toolMessagePropsFixture({ toolName: 'intercom', ...overrides }).props;

const resultOf = (text: string, details: unknown) => ({ content: [{ type: 'text', text }], details });

const DELIVERED = 'sent to reviewer';
const ANSWER = ['reviewer answered:', '', 'the launch dialog reads well; the model picker needs a default'].join('\n');

const meta = {
  title: 'Team/IntercomToolMessage',
  component: IntercomToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">send · delivered</span>
        <IntercomToolMessage
          {...props({
            args: { action: 'send', to: 'reviewer', message: 'the diff is ready for a look' },
            result: resultOf(DELIVERED, { delivered: true, to: 'reviewer' }),
            output: DELIVERED,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">send · queued, delivery unconfirmed</span>
        <IntercomToolMessage
          {...props({
            args: { action: 'send', to: 'reviewer', message: 'the diff is ready for a look' },
            result: resultOf('queued for reviewer', { state: 'queued', to: 'reviewer' }),
            output: 'queued for reviewer',
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">ask · answered</span>
        <IntercomToolMessage
          {...props({
            args: { action: 'ask', to: 'reviewer', message: 'does the launch dialog need a model default?' },
            result: resultOf(ANSWER, { reply: 'the model picker needs a default', from: 'reviewer' }),
            output: ANSWER,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">reply · confirms its request</span>
        <IntercomToolMessage
          {...props({
            args: { action: 'reply', requestId: 'req-42', message: 'yes, ship it' },
            result: resultOf('replied to main', { requestId: 'req-42', to: 'main' }),
            output: 'replied to main',
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">waiting</span>
        <IntercomToolMessage
          {...props({
            args: { action: 'ask', to: 'reviewer', message: 'does the launch dialog need a model default?' },
            running: true,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">failed</span>
        <IntercomToolMessage
          {...props({
            args: { action: 'send', to: 'ghost', message: 'anyone there?' },
            result: resultOf('no member named ghost is active', null),
            output: 'no member named ghost is active',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
