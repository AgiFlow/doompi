import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DoomMcpToolResolverService } from '@agimon-ai/doompi-extension-contracts/mcp-tool-resolver';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatTeamContextSnapshot } from '../../src/adapters/api/teamSnapshot';
import {
  McpDirectToolResolverBinding,
  resolveMcpDirectToolNames,
  resolveMcpDirectToolSelections,
} from '../../src/adapters/runs/shared/mcpDirectToolAllowlist';
import {
  formatChildToolDiagnostic,
  readChildToolDiagnostic,
  readChildToolDiagnosticError,
  writeChildToolDiagnostic,
} from '../../src/adapters/runs/shared/toolAvailability';

const temporaryDirs: string[] = [];

function makeTempDir(suffix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `doom-team-${suffix}-`));
  // Realpath, because the lease keys on the canonical path and macOS resolves
  // the temp root through a symlink.
  temporaryDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// toolAvailability.ts
// ---------------------------------------------------------------------------

describe('child tool diagnostic', () => {
  let diagnosticPath: string;

  beforeEach(() => {
    diagnosticPath = path.join(makeTempDir('tool-availability'), 'tools.json');
  });

  it('reports a requested tool the child never registered', () => {
    // An unlisted tool is excluded from what the child can call, so the gap has
    // to surface as a diagnostic; the parent has no other view of it.
    const diagnostic = writeChildToolDiagnostic(diagnosticPath, ['read', 'browse'], ['read'], 'reviewer');

    expect(diagnostic).toEqual({
      agent: 'reviewer',
      required: ['read', 'browse'],
      available: ['read'],
      missing: ['browse'],
    });
    expect(readChildToolDiagnostic(diagnosticPath)).toEqual(diagnostic);
  });

  it('treats the core builtins as available even when the child reported none', () => {
    // The registry snapshot can be taken before the builtins finish registering,
    // and a false alarm here would train operators to ignore the diagnostic.
    expect(
      writeChildToolDiagnostic(diagnosticPath, ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'], []),
    ).toBeUndefined();
  });

  it('removes a previous run record once nothing is missing', () => {
    writeChildToolDiagnostic(diagnosticPath, ['browse'], []);
    expect(fs.existsSync(diagnosticPath)).toBe(true);

    // A stale file would be reported against a later, healthy run.
    expect(writeChildToolDiagnostic(diagnosticPath, ['read'], ['read'])).toBeUndefined();
    expect(fs.existsSync(diagnosticPath)).toBe(false);
  });

  it('omits the agent when the run has none', () => {
    const diagnostic = writeChildToolDiagnostic(diagnosticPath, ['browse'], []);
    expect(diagnostic).not.toHaveProperty('agent');
    expect(formatChildToolDiagnostic(diagnostic!)).toContain('Subagent requested');
  });

  it('separates missing MCP direct tools, which point at a registration fault', () => {
    const diagnostic = writeChildToolDiagnostic(diagnosticPath, ['browse', 'server_alpha'], [], 'reviewer', [
      'server_alpha',
    ]);

    expect(diagnostic?.missingMcpDirectTools).toEqual(['server_alpha']);
    expect(formatChildToolDiagnostic(diagnostic!)).toContain('doom-mcp registration problem');
  });

  it('omits the MCP section when no resolved MCP tool is among the missing', () => {
    const diagnostic = writeChildToolDiagnostic(diagnosticPath, ['browse'], [], 'reviewer', ['server_alpha']);

    expect(diagnostic).not.toHaveProperty('missingMcpDirectTools');
    expect(formatChildToolDiagnostic(diagnostic!)).not.toContain('registration problem');
  });

  it('treats an empty MCP tool list as no MCP tools at all', () => {
    // An empty allowlist means "nothing extra", never "everything".
    const diagnostic = writeChildToolDiagnostic(diagnosticPath, ['browse'], [], 'reviewer', []);
    expect(diagnostic).not.toHaveProperty('missingMcpDirectTools');
  });

  it('writes the record private to the user', () => {
    writeChildToolDiagnostic(diagnosticPath, ['browse'], []);
    // The record names the tools an agent asked for, which is not something a
    // shared temp directory should expose.
    expect(fs.statSync(diagnosticPath).mode & 0o077).toBe(0);
  });

  it('reads nothing when there is no path or no file', () => {
    expect(readChildToolDiagnostic(undefined)).toBeUndefined();
    expect(readChildToolDiagnostic(diagnosticPath)).toBeUndefined();
    expect(readChildToolDiagnosticError(undefined)).toBeUndefined();
  });

  const malformed: ReadonlyArray<readonly [string, string]> = [
    ['a JSON array', '[]'],
    ['a bare string', '"nope"'],
    ['a missing required list', '{"available":[],"missing":["a"]}'],
    ['a missing available list', '{"required":["a"],"missing":["a"]}'],
    ['a missing missing list', '{"required":["a"],"available":[]}'],
    ['an empty tool name', '{"required":[""],"available":[],"missing":["a"]}'],
    ['a non-string agent', '{"agent":5,"required":["a"],"available":[],"missing":["a"]}'],
    ['a non-array MCP list', '{"required":["a"],"available":[],"missing":["a"],"missingMcpDirectTools":"a"}'],
  ];

  it.each(malformed)('rejects %s rather than reading it as nothing missing', (_label, contents) => {
    fs.writeFileSync(diagnosticPath, contents);
    expect(() => readChildToolDiagnostic(diagnosticPath)).toThrow(/Malformed child tool diagnostic/);
  });

  /**
   * CURRENT BEHAVIOUR. `isNonEmptyStringArray` checks that every ENTRY is a
   * non-empty string, not that the array itself is non-empty, so a planted
   * record claiming nothing is missing parses as valid. The writer never
   * produces this (it deletes the file instead), and the reader still returns a
   * record rather than undefined, so a run carrying one is reported rather than
   * passed off as clean. Pinned so that stays true.
   */
  it('accepts a record whose missing list is empty and still reports it', () => {
    fs.writeFileSync(diagnosticPath, '{"required":["browse"],"available":[],"missing":[]}');

    expect(readChildToolDiagnostic(diagnosticPath)?.missing).toEqual([]);
    expect(readChildToolDiagnosticError(diagnosticPath)).toContain('requested unavailable child tools');
  });

  it('surfaces an unreadable record as its own error, not as a clean run', () => {
    // The file existing at all means the child had a tool gap. Returning
    // undefined here would report a broken run as a healthy one.
    fs.writeFileSync(diagnosticPath, 'not json');
    expect(readChildToolDiagnosticError(diagnosticPath)).toMatch(/Failed to read child tool availability diagnostic/);
  });

  it('formats a reportable message end to end', () => {
    writeChildToolDiagnostic(diagnosticPath, ['browse'], [], 'reviewer');
    const message = readChildToolDiagnosticError(diagnosticPath);

    expect(message).toContain("Agent 'reviewer' requested unavailable child tools: browse.");
    expect(message).toContain('strict allowlist');
  });
});

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
