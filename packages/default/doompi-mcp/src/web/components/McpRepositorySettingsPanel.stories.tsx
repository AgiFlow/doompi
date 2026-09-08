/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The panel reads its catalog through the `request` prop, so this story answers
 * that one route instead of stubbing anything global. The catalog is typed as
 * McpRepositoryCatalog, so a change to the wire shape breaks the story.
 *
 * Only one panel is given a repository: the settings store is a module
 * singleton keyed by repository id, so two loaded panels would fight over it.
 */
import type { RepositorySettingsPanelProps } from '@agimon-ai/doompi-web-contracts';
import type { McpRepositoryCatalog } from '../../types/webMcp.ts';
import { McpRepositorySettingsPanel } from './McpRepositorySettingsPanel.tsx';

const catalog: McpRepositoryCatalog = {
  repositoryId: 'repo-1',
  sync: { fresh: true, reasons: [] },
  servers: [
    {
      name: 'linear',
      state: 'connected',
      source: 'cached',
      credentialPresent: true,
      tools: [
        { name: 'list_issues', piName: 'linear_list_issues', description: 'List issues for a team' },
        { name: 'create_issue', piName: 'linear_create_issue', description: 'Open a new issue' },
      ],
    },
    {
      name: 'github',
      state: 'needs-auth',
      source: 'live',
      credentialPresent: false,
      tools: [],
      error: 'The saved credential expired on 2025-06-01.',
    },
    { name: 'sentry', state: 'not-connected', source: 'configured', credentialPresent: false, tools: [] },
  ],
  droppedServers: ['internal-shell'],
  diagnostics: ['stdio server "internal-shell" is not on the install allowlist'],
};

const request: RepositorySettingsPanelProps['request'] = (input) =>
  Promise.resolve(
    input.includes('/api/plugin/mcp/repository')
      ? new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
  );

const repository = { id: 'repo-1', name: 'doompi', path: '/Users/dev/workspace/doompi', active: true };

const meta = {
  title: 'Mcp/McpRepositorySettingsPanel',
  component: McpRepositorySettingsPanel,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">a synced catalog</span>
        <McpRepositorySettingsPanel repository={repository} request={request} requestWithStepUp={request} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">no repository selected</span>
        <McpRepositorySettingsPanel repository={null} request={request} requestWithStepUp={request} />
      </div>
    </div>
  ),
};
