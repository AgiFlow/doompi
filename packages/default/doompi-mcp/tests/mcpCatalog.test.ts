import type { McpToolInfo } from '@agimon-ai/mcp-proxy';
import { beforeEach, describe, expect, it } from 'vitest';
import { readDirectToolFilter } from '../src/adapters/process/directToolsEnvironment.ts';
import { DIRECT_TOOLS_ENV } from '../src/schemas/directTools.ts';
import { McpCatalog, toPiToolName } from '../src/services/mcpCatalog.ts';

function mcpTool(name: string, description?: string): McpToolInfo {
  return { name, inputSchema: { type: 'object' }, ...(description ? { description } : {}) };
}

let catalog: McpCatalog;

beforeEach(() => {
  catalog = new McpCatalog();
});

describe('toPiToolName', () => {
  it('prefixes with the server so agent selectors keep working across the swap', () => {
    expect(toPiToolName('pencil', 'get_screenshot')).toBe('pencil_get_screenshot');
  });

  it('replaces characters a tool name cannot carry', () => {
    expect(toPiToolName('code-intel', 'get_diagnostics')).toBe('code_intel_get_diagnostics');
    expect(toPiToolName('@scope/server', 'run')).toBe('_scope_server_run');
  });
});

describe('McpCatalog', () => {
  describe('tool selector resolution', () => {
    beforeEach(() => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [
        mcpTool('get_screenshot'),
        mcpTool('export_html'),
      ]);
      catalog.applyStateChange({ serverName: 'docs', state: 'connected' }, [mcpTool('search')]);
    });

    it('resolves whole servers, individual tools, and the all-server selector', () => {
      expect(catalog.resolveToolSelectors(['pencil/get_screenshot'])).toEqual([
        { name: 'pencil_get_screenshot', selector: 'pencil/get_screenshot' },
      ]);
      expect(catalog.resolveToolSelectors(['docs/'])).toEqual([{ name: 'docs_search', selector: 'docs/search' }]);
      expect(catalog.resolveToolSelectors(['*']).map((selection) => selection.name)).toEqual([
        'pencil_get_screenshot',
        'pencil_export_html',
        'docs_search',
      ]);
    });

    it('deduplicates overlapping selectors and fails narrow for unknown selectors', () => {
      expect(catalog.resolveToolSelectors(['pencil', 'pencil/get_screenshot'])).toHaveLength(2);
      expect(catalog.resolveToolSelectors(['missing', 'pencil/missing', '', '/search'])).toEqual([]);
    });
  });

  describe('cached seed', () => {
    it('exposes last run tools before anything connects', () => {
      catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });

      expect(catalog.allTools().map((tool) => tool.piName)).toEqual(['pencil_get_screenshot']);
    });

    // Callable straight away: mcp-proxy skips its eager connection pass whenever it
    // has a usable cache, so withholding these would leave a warm session with none.
    it('activates seeded tools before the server has reported', () => {
      catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });

      expect(catalog.activeToolNames()).toEqual(['pencil_get_screenshot']);
      expect(catalog.toSnapshot().servers[0].state).toBe('not-connected');
    });
  });

  describe('folding in live servers', () => {
    it('activates a server tools once it connects', () => {
      catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });

      const added = catalog.applyStateChange({ serverName: 'pencil', state: 'connected' });

      expect(added).toEqual([]);
      expect(catalog.activeToolNames()).toEqual(['pencil_get_screenshot']);
    });

    it('reports tools the cache did not have so the caller can register them', () => {
      catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });

      const added = catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [
        mcpTool('get_screenshot'),
        mcpTool('export_html'),
      ]);

      expect(added.map((tool) => tool.piName)).toEqual(['pencil_export_html']);
      expect(catalog.activeToolNames()).toEqual(['pencil_get_screenshot', 'pencil_export_html']);
    });

    it('accepts a server that was never in the cache', () => {
      const added = catalog.applyStateChange({ serverName: 'boomlink', state: 'connected' }, [mcpTool('search')]);

      expect(added.map((tool) => tool.piName)).toEqual(['boomlink_search']);
      expect(catalog.activeToolNames()).toEqual(['boomlink_search']);
    });

    it('does not register the same tool twice across reconnects', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);

      const added = catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);

      expect(added).toEqual([]);
      expect(catalog.allTools()).toHaveLength(1);
    });

    it('keeps a degraded server usable', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);

      catalog.applyStateChange({ serverName: 'pencil', state: 'degraded', error: 'flaky' });

      expect(catalog.activeToolNames()).toEqual(['pencil_get_screenshot']);
    });
  });

  describe('when a server goes away', () => {
    // Pi 0.84 has no unregisterTool, so removal has to happen through the active list.
    it('drops its tools from the active set but keeps them registered', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);

      catalog.applyStateChange({ serverName: 'pencil', state: 'failed', error: 'spawn ENOENT' });

      expect(catalog.activeToolNames()).toEqual([]);
      expect(catalog.allTools().map((tool) => tool.piName)).toEqual(['pencil_get_screenshot']);
    });

    it('reports why', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'failed', error: 'spawn ENOENT' });

      expect(catalog.toSnapshot().servers[0]).toMatchObject({ state: 'failed', error: 'spawn ENOENT' });
    });

    it('clears the error when the server recovers', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'failed', error: 'spawn ENOENT' });

      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' });

      expect(catalog.toSnapshot().servers[0].error).toBeUndefined();
    });

    it('holds a needs-auth server inactive until it is authorized', () => {
      catalog.applyStateChange({ serverName: 'boomlink', state: 'connected' }, [mcpTool('search')]);

      catalog.applyStateChange({ serverName: 'boomlink', state: 'needs-auth', error: 'authorization required' });

      expect(catalog.activeToolNames()).toEqual([]);
    });
  });

  describe('name collisions', () => {
    it('keeps the first claim and reports the loser rather than shadowing it', () => {
      catalog.applyStateChange({ serverName: 'code-intel', state: 'connected' }, [mcpTool('run')]);

      const added = catalog.applyStateChange({ serverName: 'code_intel', state: 'connected' }, [mcpTool('run')]);

      expect(added).toEqual([]);
      expect(catalog.getDiagnostics()).toHaveLength(1);
      expect(catalog.getDiagnostics()[0]).toContain('code_intel_run');
    });

    it('lets one server keep its own name across reconnects', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('run')]);
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('run')]);

      expect(catalog.getDiagnostics()).toEqual([]);
    });
  });

  describe('disabled servers', () => {
    it('lists a configured server that is never dialled', () => {
      catalog.setDisabled('xcode', true);

      expect(catalog.toSnapshot().servers).toEqual([{ name: 'xcode', state: 'disabled', tools: [], resourceCount: 0 }]);
    });

    it('marks a seeded server disabled without losing its cached tools', () => {
      catalog.seed({ servers: [{ name: 'xcode', tools: [mcpTool('build')] }] });

      catalog.setDisabled('xcode', true);

      expect(catalog.toSnapshot().servers[0]).toMatchObject({ state: 'disabled', tools: ['xcode_build'] });
      expect(catalog.activeToolNames()).toEqual([]);
    });

    // The reason disable is a flag rather than a state: overwriting `state` would
    // leave nothing to come back to.
    it('restores the state the server last reported when it is re-enabled', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);

      catalog.setDisabled('pencil', true);
      expect(catalog.activeToolNames()).toEqual([]);
      expect(catalog.toSnapshot().servers[0].state).toBe('disabled');

      catalog.setDisabled('pencil', false);

      expect(catalog.activeToolNames()).toEqual(['pencil_get_screenshot']);
      expect(catalog.toSnapshot().servers[0].state).toBe('connected');
    });

    it('records a transition that lands while disabled without reactivating the server', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);
      catalog.setDisabled('pencil', true);

      catalog.applyStateChange({ serverName: 'pencil', state: 'failed', error: 'spawn ENOENT' });

      expect(catalog.activeToolNames()).toEqual([]);
      expect(catalog.toSnapshot().servers[0]).toMatchObject({ state: 'disabled', error: 'spawn ENOENT' });
      expect(catalog.toView()[0]).toMatchObject({ state: 'failed', enabled: false });
    });
  });

  describe('view', () => {
    it('carries the downstream name and description the Pi name cannot be reversed to', () => {
      catalog.applyStateChange({ serverName: 'code-intel', state: 'connected' }, [mcpTool('run', 'Runs it')]);

      expect(catalog.toView()).toEqual([
        {
          name: 'code-intel',
          state: 'connected',
          resourceCount: 0,
          enabled: true,
          tools: [{ piName: 'code_intel_run', toolName: 'run', description: 'Runs it', active: true }],
        },
      ]);
    });

    it('marks a tool a child agent selection withholds as inactive', () => {
      const filtered = new McpCatalog(readDirectToolFilter({ [DIRECT_TOOLS_ENV]: 'pencil/get_screenshot' }));
      filtered.applyStateChange({ serverName: 'pencil', state: 'connected' }, [
        mcpTool('get_screenshot'),
        mcpTool('export_html'),
      ]);

      expect(filtered.toView()[0].tools.map((tool) => [tool.toolName, tool.active])).toEqual([
        ['get_screenshot', true],
        ['export_html', false],
      ]);
      expect(filtered.activeToolNames()).toEqual(['pencil_get_screenshot']);
    });

    it('reports resources counted the last time they were listed', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' });

      catalog.setResourceCount('pencil', 3);

      expect(catalog.toView()[0].resourceCount).toBe(3);
      expect(catalog.toSnapshot().servers[0].resourceCount).toBe(3);
    });

    it('ignores a resource count for a server it does not know', () => {
      catalog.setResourceCount('ghost', 3);

      expect(catalog.toView()).toEqual([]);
    });
  });

  describe('snapshot', () => {
    it('names each server tools so a consumer never has to guess the prefix', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')], 3);

      expect(catalog.toSnapshot()).toEqual({
        servers: [{ name: 'pencil', state: 'connected', tools: ['pencil_get_screenshot'], resourceCount: 3 }],
      });
    });

    it('finds the downstream tool behind a Pi tool name', () => {
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot', 'Shoot')]);

      expect(catalog.findTool('pencil_get_screenshot')).toMatchObject({
        serverName: 'pencil',
        toolName: 'get_screenshot',
        description: 'Shoot',
      });
    });

    it('reports nothing for a tool it does not own', () => {
      expect(catalog.findTool('read')).toBeUndefined();
    });
  });
});
