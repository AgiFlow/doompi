import type { DoomMcpToolResolverService } from '@agimon-ai/doompi-core/mcp-tool-resolver';
import { describe, expect, it } from 'vitest';

import {
  McpDirectToolResolverBinding,
  resolveMcpDirectToolNames,
  resolveMcpDirectToolSelections,
} from '../../src/services/mcpDirectToolAllowlist';
import { formatTeamContextSnapshot } from '../../src/services/teamSnapshot';

// ---------------------------------------------------------------------------
// mcpDirectToolAllowlist.ts
// ---------------------------------------------------------------------------

describe('mcp direct tool resolver binding', () => {
  function service(generation: string, resolve: DoomMcpToolResolverService['resolve']): DoomMcpToolResolverService {
    return { generation, resolve };
  }

  it('resolves nothing when MCP is absent or no selector was requested', () => {
    const binding = new McpDirectToolResolverBinding();

    expect(resolveMcpDirectToolSelections(undefined, binding)).toEqual([]);
    expect(resolveMcpDirectToolSelections([], binding)).toEqual([]);
    expect(resolveMcpDirectToolNames(['pencil'], binding)).toEqual([]);
  });

  it('delegates selector resolution to the active provider', () => {
    const binding = new McpDirectToolResolverBinding();
    binding.bind(
      service('first', (selectors) =>
        selectors.includes('pencil') ? [{ name: 'pencil_get_screenshot', selector: 'pencil/get_screenshot' }] : [],
      ),
    );

    expect(resolveMcpDirectToolSelections(['pencil'], binding)).toEqual([
      { name: 'pencil_get_screenshot', selector: 'pencil/get_screenshot' },
    ]);
    expect(resolveMcpDirectToolNames(['pencil'], binding)).toEqual(['pencil_get_screenshot']);
  });

  it('fails narrow when a provider throws', () => {
    const binding = new McpDirectToolResolverBinding();
    binding.bind(
      service('broken', () => {
        throw new Error('catalog unavailable');
      }),
    );

    expect(resolveMcpDirectToolSelections(['pencil'], binding)).toEqual([]);
  });

  it('clears a removed provider and rebinds without a stale disposer clearing the replacement', () => {
    const binding = new McpDirectToolResolverBinding();
    const disposeFirst = binding.bind(service('first', () => [{ name: 'first_tool', selector: 'first/tool' }]));
    const disposeSecond = binding.bind(service('second', () => [{ name: 'second_tool', selector: 'second/tool' }]));

    disposeFirst();
    expect(resolveMcpDirectToolNames(['*'], binding)).toEqual(['second_tool']);

    disposeSecond();
    disposeSecond();
    expect(resolveMcpDirectToolNames(['*'], binding)).toEqual([]);
  });
});

describe('Team context contribution', () => {
  it('renders only the resumable member fields', () => {
    expect(
      formatTeamContextSnapshot({
        members: [
          {
            name: 'reviewer',
            role: 'subagent',
            agent: 'reviewer',
            runId: 'run-1',
            task: { id: 'task-1', subject: 'Review the patch' },
          },
        ],
      }),
    ).toBe('- reviewer | role: subagent | agent: reviewer | run: run-1 | task task-1: Review the patch');
  });

  it('omits an unavailable runtime and reports an empty active team', () => {
    expect(formatTeamContextSnapshot(undefined)).toBeUndefined();
    expect(formatTeamContextSnapshot({ members: [] })).toBe('(no active team members)');
  });
});
