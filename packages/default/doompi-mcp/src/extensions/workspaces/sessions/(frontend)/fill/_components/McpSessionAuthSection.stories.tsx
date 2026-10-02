/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The servers arrive as the session status string this package publishes, and
 * are built with `formatMcpSessionAuthStatus` rather than a hand-written JSON
 * literal, so a story cannot show a shape the parser would reject.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-core/webTesting';

import { formatMcpSessionAuthStatus, MCP_SESSION_AUTH_STATUS_KEY } from '../../../../../../types/webMcp';
import { McpSessionAuthSection } from './McpSessionAuthSection';

const status = formatMcpSessionAuthStatus([
  {
    name: 'linear',
    state: 'connected',
    tools: [
      { toolName: 'list_issues', piName: 'linear_list_issues', active: true },
      { toolName: 'create_issue', piName: 'linear_create_issue', active: true },
    ],
  },
  { name: 'github', state: 'needs-auth', authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=x' },
  { name: 'sentry', state: 'connecting' },
  { name: 'notion', state: 'failed' },
  { name: 'slack', state: 'disabled' },
]);

const slot = slotPropsFixture({
  sessionId: 's1',
  statuses: { [MCP_SESSION_AUTH_STATUS_KEY]: status ?? '' },
  contextInventory: [
    { name: 'linear_list_issues', itemKind: 'tool', source: 'mcp', owner: 'linear', tokens: 1420, active: true },
    { name: 'linear_create_issue', itemKind: 'tool', source: 'mcp', owner: 'linear', tokens: 980, active: true },
    { name: 'linear_search_docs', itemKind: 'tool', source: 'mcp', owner: 'linear', tokens: 610, active: false },
    { name: 'github_list_repos', itemKind: 'tool', source: 'mcp', owner: 'github', tokens: null, active: false },
  ],
}).props;

/** No session focused: every button is disabled, which is the read-only shape. */
const noSession = slotPropsFixture({
  sessionId: null,
  statuses: { [MCP_SESSION_AUTH_STATUS_KEY]: status ?? '' },
}).props;

const meta = {
  title: 'Mcp/McpSessionAuthSection',
  component: McpSessionAuthSection,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          five states, with the tools each server contributes
        </span>
        <McpSessionAuthSection {...slot} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          no session focused · nothing actionable
        </span>
        <McpSessionAuthSection {...noSession} />
      </div>
    </div>
  ),
};

export const Manage = {
  render: () => (
    <div className="bg-doom-bg p-6">
      <McpSessionAuthSection
        {...slotPropsFixture({
          sessionId: 's1',
          statuses: {
            [MCP_SESSION_AUTH_STATUS_KEY]:
              formatMcpSessionAuthStatus([{ name: 'scaffold-mcp', state: 'connected' }]) ?? '',
          },
        }).props}
      />
    </div>
  ),
};

export const Accounts = {
  render: () => (
    <div className="bg-doom-bg p-6">
      <McpSessionAuthSection
        {...slotPropsFixture({
          sessionId: 'accounts',
          statuses: {
            [MCP_SESSION_AUTH_STATUS_KEY]:
              formatMcpSessionAuthStatus([
                {
                  name: 'personal',
                  state: 'connected',
                  tools: [{ toolName: 'search', piName: 'personal_search', active: true, tokens: 180 }],
                },
                {
                  name: 'work',
                  state: 'connected',
                  tools: [{ toolName: 'search', piName: 'work_search', active: true, tokens: 180 }],
                },
              ]) ?? '',
          },
          contextInventory: [
            { name: 'personal_search', itemKind: 'tool', source: 'mcp', owner: 'personal', tokens: 180, active: true },
            { name: 'work_search', itemKind: 'tool', source: 'mcp', owner: 'work', tokens: 180, active: true },
          ],
        }).props}
      />
    </div>
  ),
};
