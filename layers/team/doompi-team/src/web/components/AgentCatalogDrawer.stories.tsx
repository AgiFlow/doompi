/*
 * Plain CSF objects; the style-system renderer parses these files statically
 * and mounts the exported `render`, so no Storybook runtime is imported and the
 * default export is a bare `const meta`. The rows come from the real catalog
 * session store, seeded at module scope, which is the drawer's only input.
 */
import type { SubagentCatalogAgent } from '../../types/webSubagents';
import { catalog } from '../stores/catalogStore';
import { AgentCatalogDrawer } from './AgentCatalogDrawer';

const agent = (
  overrides: Partial<SubagentCatalogAgent> & Pick<SubagentCatalogAgent, 'name' | 'source' | 'description'>,
): SubagentCatalogAgent => ({
  fallbackModels: [],
  tools: [],
  skills: [],
  extensions: [],
  defaultContext: 'fresh',
  filePath: `.doom/agents/${overrides.name}.md`,
  ...overrides,
});

catalog.update('catalog-full', (current) => ({
  ...current,
  cwd: '/Users/dev/workspace/doompi',
  models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'],
  open: true,
  selected: 'reviewer',
  inspected: 'reviewer',
  agents: [
    agent({
      name: 'reviewer',
      source: 'project',
      description: 'reviews a diff for defects, regressions, and contract violations',
      model: 'anthropic/claude-sonnet-4-5',
      tools: ['read', 'grep', 'bash', 'edit'],
      skills: ['doompi-review'],
      extensions: ['doompi-file-edit'],
    }),
    agent({
      name: 'tester',
      source: 'project',
      description: 'writes and runs the focused suites for a change',
      tools: ['read', 'bash'],
      skills: ['doompi-testing'],
      defaultContext: 'fork',
    }),
    agent({
      name: 'scout',
      source: 'user',
      description: 'reads a codebase and reports back without editing',
      filePath: '~/.doompi/agent/agents/scout.md',
    }),
    agent({
      name: 'ponytail',
      source: 'plugin',
      packageName: '@agimon-ai/doompi-development',
      description: 'the lazy senior developer; smallest coherent change, no scaffolding',
      tools: ['read', 'edit', 'bash', 'grep', 'write'],
      filePath: 'plugins/development/agents/ponytail.md',
    }),
  ],
}));

catalog.update('catalog-empty', (current) => ({
  ...current,
  cwd: '/tmp/scratch',
  open: true,
  warning: 'the agent directory could not be read: EACCES',
}));

const meta = {
  title: 'Team/AgentCatalogDrawer',
  component: AgentCatalogDrawer,
  tags: ['style-system'],
};

export default meta;

const noop = () => {};

export const Playground = {
  render: () => (
    <div className="flex h-screen gap-6 bg-doom-bg p-6">
      <AgentCatalogDrawer sessionId="catalog-full" onClose={noop} onLaunch={noop} />
      <AgentCatalogDrawer sessionId="catalog-empty" onClose={noop} onLaunch={noop} />
    </div>
  ),
};
