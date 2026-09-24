import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/webTesting';

import { HelpStatusCard } from './HelpStatusCard';

const meta = {
  title: 'Help/HelpStatusCard',
  component: HelpStatusCard,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <HelpStatusCard {...toolMessagePropsFixture({ toolName: 'help_status', running: true }).props} />
      <HelpStatusCard
        {...toolMessagePropsFixture({
          toolName: 'help_status',
          output: JSON.stringify({ activation: 'active', counts: { skills: 8, tools: 3 }, diagnostics: [] }, null, 2),
        }).props}
      />
      <HelpStatusCard
        {...toolMessagePropsFixture({
          toolName: 'help_status',
          output: JSON.stringify(
            {
              activation: 'degraded',
              counts: { skills: 7, tools: 3 },
              diagnostics: [{ source: '@fixture/missing-resource', code: 'HELP_UNAVAILABLE' }],
              truncated: false,
            },
            null,
            2,
          ),
        }).props}
      />
      <HelpStatusCard
        {...toolMessagePropsFixture({ toolName: 'help_status', output: 'Help mode is not active.', isError: true })
          .props}
      />
    </div>
  ),
};
