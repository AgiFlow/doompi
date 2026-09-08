/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 *
 * The servers arrive as the session status string this package publishes, and
 * are built with `formatMcpSessionAuthStatus` rather than a hand-written JSON
 * literal, so a story cannot show a shape the parser would reject.
 */
import { slotPropsFixture } from '@agimon-ai/doompi-web-contracts/testing';
import { formatMcpSessionAuthStatus, MCP_SESSION_AUTH_STATUS_KEY } from '../../types/webMcp.ts';
import { McpSessionAuthSection } from './McpSessionAuthSection.tsx';

const status = formatMcpSessionAuthStatus([
  { name: 'linear', state: 'connected' },
  { name: 'github', state: 'needs-auth', authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=x' },
  { name: 'sentry', state: 'connecting' },
  { name: 'notion', state: 'failed' },
  { name: 'slack', state: 'disabled' },
]);

const slot = slotPropsFixture({
  sessionId: 's1',
  statuses: { [MCP_SESSION_AUTH_STATUS_KEY]: status ?? '' },
  contextInventory: [
    { name: 'list_issues', itemKind: 'tool', source: 'mcp', owner: 'linear', tokens: 1420, active: true },
    { name: 'create_issue', itemKind: 'tool', source: 'mcp', owner: 'linear', tokens: 980, active: true },
    { name: 'search_docs', itemKind: 'tool', source: 'mcp', owner: 'linear', tokens: 610, active: false },
    { name: 'list_repos', itemKind: 'tool', source: 'mcp', owner: 'github', tokens: null, active: false },
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
