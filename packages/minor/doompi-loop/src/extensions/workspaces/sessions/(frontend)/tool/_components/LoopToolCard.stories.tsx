import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/webTesting';

import { LoopToolCard } from './LoopToolCard';

const meta = {
  title: 'Loop/LoopToolCard',
  component: LoopToolCard,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex max-w-3xl flex-col gap-6 bg-doom-bg p-6">
      <LoopToolCard {...toolMessagePropsFixture({ toolName: 'loop_start', running: true }).props} />
      <LoopToolCard
        {...toolMessagePropsFixture({
          toolName: 'loop_list',
          result: { content: [{ type: 'text', text: 'No active loops.' }], details: {} },
        }).props}
      />
      <LoopToolCard
        {...toolMessagePropsFixture({
          toolName: 'loop_list',
          result: {
            content: [{ type: 'text', text: 'Two loops are active.' }],
            details: {
              loops: [
                { id: 'review', name: 'Review component stories', state: 'running' },
                { id: 'verify', name: 'Verify styling and accessibility', state: 'waiting' },
              ],
            },
          },
        }).props}
      />
      <LoopToolCard
        {...toolMessagePropsFixture({
          toolName: 'loop_stop',
          isError: true,
          result: { content: [{ type: 'text', text: 'The requested loop no longer exists.' }], details: {} },
        }).props}
      />
    </div>
  ),
};
