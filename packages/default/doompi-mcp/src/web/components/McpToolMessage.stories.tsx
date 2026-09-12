/*
 * Plain CSF objects; the style-system renderer resolves the default export by
 * finding a bare `const meta`, so it is not named at the point of definition.
 * The props come from the contracts package's own testing fixture rather than
 * a hand-rolled stub, so a change to the render contract breaks this story at
 * the type level instead of silently drifting.
 */
import { toolMessagePropsFixture } from '@agimon-ai/doompi-core/web/testing';
import type { McpToolDetails } from '../../types/webMcp';
import { McpToolMessage } from './McpToolMessage';
import { MCP_STATUS_KEY } from '../lib/mcpToolMatch';

/** The server names the session publishes, which is how a call is recognised without details. */
const statuses = { [MCP_STATUS_KEY]: 'linear,github' };

const SHORT = ['LIN-4821 Cockpit metrics panel', 'LIN-4822 Prompt library dialog'].join('\n');

const LONG = Array.from(
  { length: 18 },
  (_, index) => `LIN-${String(4821 + index)} issue title ${String(index + 1)}`,
).join('\n');

const details: McpToolDetails = {
  server: 'linear',
  tool: 'list_issues',
  blocks: [
    {
      type: 'resource_link',
      uri: 'https://linear.app/doompi/issue/LIN-4821',
      name: 'LIN-4821',
      title: 'Cockpit metrics panel',
      description: 'Draw the log sink report in settings',
    },
    { type: 'structured', value: { total: 2, cursor: null, hasMore: false } },
    {
      type: 'resource',
      uri: 'linear://doompi/query.graphql',
      mimeType: 'application/graphql',
      text: '{ issues { id } }',
    },
    { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
  ],
};

const props = (overrides: Parameters<typeof toolMessagePropsFixture>[0]) =>
  toolMessagePropsFixture({ statuses, ...overrides }).props;

const meta = {
  title: 'Mcp/McpToolMessage',
  component: McpToolMessage,
  tags: ['style-system'],
};

export default meta;

export const Playground = {
  render: () => (
    <div className="flex flex-col gap-6 bg-doom-bg p-6">
      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          running · server from the session status
        </span>
        <McpToolMessage
          {...props({ toolName: 'linear_list_issues', args: { team: 'doompi', limit: 25 }, running: true })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">complete · text only</span>
        <McpToolMessage
          {...props({
            toolName: 'linear_list_issues',
            args: { team: 'doompi', limit: 25 },
            result: { content: [{ type: 'text', text: SHORT }], details: null },
            output: SHORT,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          complete · identity and blocks from the details
        </span>
        <McpToolMessage
          {...props({
            toolName: 'linear_list_issues',
            args: { team: 'doompi', state: 'open', limit: 25, cursor: null },
            result: { content: [{ type: 'text', text: SHORT }], details },
            output: SHORT,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          complete · collapsed to twelve lines, expandable
        </span>
        <McpToolMessage
          {...props({
            toolName: 'linear_list_issues',
            args: { team: 'doompi' },
            result: { content: [{ type: 'text', text: LONG }], details: null },
            output: LONG,
          })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-2xs text-doom-dim uppercase tracking-widest">
          failed · server the session never named
        </span>
        <McpToolMessage
          {...props({
            toolName: 'notion_search',
            args: { query: 'release checklist' },
            result: { content: [{ type: 'text', text: 'MCP error -32001: request timed out' }], details: null },
            output: 'MCP error -32001: request timed out',
            isError: true,
          })}
        />
      </div>
    </div>
  ),
};
