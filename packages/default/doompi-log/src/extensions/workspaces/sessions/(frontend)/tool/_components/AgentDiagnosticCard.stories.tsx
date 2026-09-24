import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/webTesting';

import { AgentDiagnosticCard } from './AgentDiagnosticCard';

const meta = {
  title: 'Log/AgentDiagnosticCard',
  component: AgentDiagnosticCard,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <AgentDiagnosticCard {...toolMessagePropsFixture({ toolName: 'diagnose_agent', running: true }).props} />
      <AgentDiagnosticCard
        {...toolMessagePropsFixture({
          toolName: 'diagnose_agent',
          output: JSON.stringify(
            {
              scope: 'current-session',
              evidence: 'available',
              capturedRecords: 12,
              capturedIssues: 2,
              captureCompleteness: 'not-reported',
            },
            null,
            2,
          ),
        }).props}
      />
      <AgentDiagnosticCard
        {...toolMessagePropsFixture({
          toolName: 'diagnose_agent',
          output: JSON.stringify(
            {
              scope: 'current-session',
              evidence: 'empty',
              capturedRecords: 0,
              limitations: 'Empty data is not proof of a healthy run.',
            },
            null,
            2,
          ),
        }).props}
      />
      <AgentDiagnosticCard
        {...toolMessagePropsFixture({
          toolName: 'diagnose_agent',
          output: 'Telemetry reader unavailable.',
          isError: true,
        }).props}
      />
    </div>
  ),
};
