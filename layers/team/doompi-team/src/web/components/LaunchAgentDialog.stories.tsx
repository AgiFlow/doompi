/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`. The dialog is always open and portals
 * to the body, so one instance is shown; the frame sender comes from the
 * contracts package's own testing fixture.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import type { SubagentCatalogAgent } from '../../types/webSubagents.ts';
import { LaunchAgentDialog } from './LaunchAgentDialog.tsx';

const REVIEWER: SubagentCatalogAgent = {
  name: 'reviewer',
  source: 'project',
  description: 'reviews a diff for defects, regressions, missing tests, and contract violations',
  model: 'anthropic/claude-sonnet-4-5',
  fallbackModels: ['anthropic/claude-haiku-4-5'],
  tools: ['read', 'grep', 'bash'],
  skills: ['doompi-review'],
  extensions: [],
  defaultContext: 'fresh',
  filePath: '.doom/agents/reviewer.md',
};

const meta = {
  title: 'Team/LaunchAgentDialog',
  component: LaunchAgentDialog,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="h-96 bg-doom-bg">
      <LaunchAgentDialog
        sessionId="launch"
        agent={REVIEWER}
        cwd="/Users/dev/workspace/doompi/layers/team/doompi-team"
        models={['anthropic/claude-sonnet-4-5', 'openai/gpt-5', 'google/gemini-3-pro']}
        fork={false}
        initialTask="review the team stories batch and report anything that will not mount"
        send={slotPropsFixture({ sessionId: 'launch' }).props.sendSessionFrame}
        onClose={() => {}}
        onLaunched={() => {}}
      />
    </div>
  ),
};
