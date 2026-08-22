import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createChildPromptCacheProjection, sha256Base64Url } from '@agimon-ai/doompi-cache';
import {
  DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV,
  DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV,
  DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV,
} from '@agimon-ai/doompi-cache/env';
import { readChildProcessContext } from '@agimon-ai/doompi-extension-contracts/child-process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
  DOOMPI_CHILD_EXTENSIONS_ENV,
  DOOMPI_SKILL_DIRS_ENV,
  INHERIT_PROJECT_CONTEXT_ENV,
  INHERIT_SKILLS_ENV,
  MCP_DIRECT_CHILD_TOOLS_ENV,
  MCP_DIRECT_TOOLS_ENV,
  REQUIRED_CHILD_TOOLS_ENV,
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
  SUBAGENT_CAPABILITY_CEILING_ENV,
  SUBAGENT_CHILD_ENV,
  SUBAGENT_FANOUT_CHILD_ENV,
  SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
  SUBAGENT_PARENT_CONTROL_INBOX_ENV,
  SUBAGENT_PARENT_DEPTH_ENV,
  SUBAGENT_PARENT_EVENT_SINK_ENV,
  SUBAGENT_PARENT_PATH_ENV,
  SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
  SUBAGENT_PARENT_RUN_ID_ENV,
  SUBAGENT_PARENT_SESSION_ENV,
  SUBAGENT_PROTECTED_PARENT_PIDS_ENV,
  SUBAGENT_STEER_ACK_DIR_ENV,
  SUBAGENT_STEER_CAPABILITY_ENV,
  SUBAGENT_STEER_INBOX_ENV,
  TOOL_BUDGET_ENV,
  TOOL_BUDGET_ZERO_AUTH_ENV,
} from '../../src/exports/env';
import {
  decodeSubagentCapabilityCeiling,
  encodeSubagentCapabilityCeiling,
} from '../../src/schemas/team/capabilityCeiling';
import { NATIVE_TEAM_TOOL_NAME } from '../../src/adapters/intercom/nativeTeamChannel';
import type { McpDirectToolResolver } from '../../src/adapters/runs/shared/mcpDirectToolAllowlist';
import {
  applyThinkingSuffix,
  type BuildPiArgsInput,
  buildPiArgs,
  cleanupTempDir,
  parseParentPathEnv,
  resolvePiLaunchToolPlan,
  resolvePiSdkResourcePlan,
} from '../../src/adapters/runs/shared/piArgs';
import { decodeToolBudgetEnv, type ResolvedToolBudget } from '../../src/adapters/runs/shared/toolBudget';

/*
 * NOTE ON COVERAGE FOR THIS FILE:
 *
 * `port-steering` has landed the non-fanout runtime extension
 * (`subagentPromptRuntimeEntry.cts`), so `resolvePiLaunchToolPlan` and
 * `buildPiArgs` now resolve for every launch that does NOT grant the
 * `subagent` tool. `extension/fanout-child` has not landed yet, so any launch
 * that ends up authorized to fan out (`declaredBuiltinTools` includes
 * `'subagent'`) still throws "Could not resolve runtime extension
 * extension/fanout-child" - see the dedicated test below pinning that as the
 * current, tracked state rather than silently skipping it. Every other case
 * these two functions reach is covered here.
 */

const temporaryDirs: string[] = [];
const NO_MCP_DIRECT_TOOLS_SENTINEL = '__none__';

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-pi-args-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  // Supervisor channel dirs land under this process's own TEMP_ROOT_DIR
  // scope (see paths.ts), not under a per-test temp dir, so they are swept
  // here rather than tracked individually.
});

/** Every env var buildPiArgs can write, saved and restored around tests that read/write process.env. */
const ENV_VAR_KEYS = [
  SUBAGENT_CAPABILITY_CEILING_ENV,
  SUBAGENT_PARENT_EVENT_SINK_ENV,
  SUBAGENT_PARENT_CONTROL_INBOX_ENV,
  SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
  SUBAGENT_PARENT_RUN_ID_ENV,
  SUBAGENT_PARENT_CHILD_INDEX_ENV,
  SUBAGENT_PARENT_DEPTH_ENV,
  SUBAGENT_PARENT_PATH_ENV,
  SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
  SUBAGENT_PARENT_SESSION_ENV,
  SUBAGENT_PROTECTED_PARENT_PIDS_ENV,
  DOOMPI_CHILD_EXTENSIONS_ENV,
  DOOMPI_SKILL_DIRS_ENV,
  DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV,
  DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV,
  DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV,
  'PI_CODING_AGENT_DIR',
] as const;

const savedEnv = Object.fromEntries(ENV_VAR_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_VAR_KEYS)[number],
  string | undefined
>;

function restoreEnv(): void {
  for (const key of ENV_VAR_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnv);

/**
 * A minimal, always-resolvable `BuildPiArgsInput`. Never grants `subagent`, so
 * every test built on top of this stays on the non-fanout path that actually
 * resolves today; see the module-level coverage note.
 */
function baseBuildInput(overrides: Partial<BuildPiArgsInput> = {}): BuildPiArgsInput {
  return {
    baseArgs: [],
    task: 'do the thing',
    sessionEnabled: false,
    inheritProjectContext: true,
    inheritSkills: true,
    ...overrides,
  };
}

/**
 * A provider-shaped MCP fixture. MCP owns catalog and naming behavior; Team only
 * consumes the neutral resolver contract and must not reconstruct either.
 */
function setUpMcpFixture(): {
  agentDir: string;
  toolName: string;
  selector: string;
  mcpToolResolver: McpDirectToolResolver;
} {
  const agentDir = makeTempDir();
  const toolName = 'search_web_search';
  const selector = 'search/web_search';
  return {
    agentDir,
    toolName,
    selector,
    mcpToolResolver: {
      resolve: (selectors) =>
        selectors.includes('search') || selectors.includes('*') ? [{ name: toolName, selector }] : [],
    },
  };
}

describe('applyThinkingSuffix', () => {
  it('returns the model unchanged when there is no thinking level', () => {
    expect(applyThinkingSuffix('sonnet', undefined)).toBe('sonnet');
    expect(applyThinkingSuffix('sonnet', false)).toBe('sonnet');
  });

  it('returns undefined for an undefined model regardless of thinking', () => {
    expect(applyThinkingSuffix(undefined, 'high')).toBeUndefined();
  });

  it('appends the level when the model has none', () => {
    expect(applyThinkingSuffix('sonnet', 'high')).toBe('sonnet:high');
  });

  it('keeps an existing known level unless told to replace it, so an explicit per-agent choice survives an inherited one', () => {
    expect(applyThinkingSuffix('sonnet:low', 'high')).toBe('sonnet:low');
    expect(applyThinkingSuffix('sonnet:low', 'high', true)).toBe('sonnet:high');
  });

  it('treats a colon suffix that is not a known thinking level as part of the model id, not a level to replace', () => {
    // "vendor:free" is the design-pattern comment's own example: a model id that
    // legitimately contains a colon must not be mistaken for level:high.
    expect(applyThinkingSuffix('openrouter/vendor:free', 'high')).toBe('openrouter/vendor:free:high');
  });
});

describe('cleanupTempDir', () => {
  it('is a no-op success for a null or undefined dir', () => {
    expect(cleanupTempDir(null)).toBe(true);
    expect(cleanupTempDir(undefined)).toBe(true);
  });

  it('removes a real directory and reports success', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
    expect(cleanupTempDir(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reports failure rather than throwing when the directory cannot be removed', () => {
    // A path that never existed is the portable stand-in for "removal failed":
    // rmSync with force:true would normally swallow ENOENT, so this exercises
    // the same non-throwing contract without relying on filesystem permissions.
    expect(cleanupTempDir(path.join(makeTempDir(), 'never-existed'))).toBe(true);
  });
});

describe('parseParentPathEnv', () => {
  it('is the same sanitizing parser used elsewhere to decode the env var', () => {
    expect(parseParentPathEnv(JSON.stringify([{ runId: 'a', stepIndex: 1 }]))).toEqual([{ runId: 'a', stepIndex: 1 }]);
    expect(parseParentPathEnv(undefined)).toEqual([]);
  });

  it('drops a malformed entry instead of throwing, since a broken ancestry record must not fail the run carrying it', () => {
    expect(parseParentPathEnv('not json')).toEqual([]);
    expect(parseParentPathEnv(JSON.stringify([{ runId: '../escape' }]))).toEqual([]);
  });
});

describe('resolvePiLaunchToolPlan - the security boundary: what a child may call', () => {
  it('grants exactly the tools requested, nothing more, when there is no ceiling', () => {
    const plan = resolvePiLaunchToolPlan({ tools: ['read', 'write'] });

    expect(plan.declaredBuiltinTools).toEqual(['read', 'write']);
    expect(plan.effectiveToolAllowlist).toEqual(['read', 'write']);
    // Not `.toContain` - a tool declaring [read, write] must not silently pick
    // up a third tool from anywhere else in the plan.
    expect(plan.effectiveToolAllowlist).not.toContain('bash');
  });

  it('narrows a requested tool set down to the ceiling, never past it', () => {
    const plan = resolvePiLaunchToolPlan({
      tools: ['read', 'write', 'bash'],
      capabilityCeiling: {
        version: 2,
        allowedTools: ['read', 'write'],
        allowedExternalProfiles: [],
        denyExtensions: false,
        sources: ['test'],
      },
    });

    expect(plan.declaredBuiltinTools).toEqual(['read', 'write']);
    expect(plan.effectiveToolAllowlist).toEqual(['read', 'write']);
    expect(plan.effectiveToolAllowlist).not.toContain('bash');
  });

  it('intersects two ceilings (this process and the one it inherited) rather than picking either alone', () => {
    const plan = resolvePiLaunchToolPlan({
      tools: ['read', 'write', 'bash'],
      capabilityCeiling: {
        version: 2,
        allowedTools: ['read', 'write'],
        allowedExternalProfiles: [],
        denyExtensions: false,
        sources: ['ours'],
      },
      inheritedCapabilityCeiling: {
        version: 2,
        allowedTools: ['write', 'bash'],
        allowedExternalProfiles: [],
        denyExtensions: false,
        sources: ['inherited'],
      },
    });

    // Only 'write' survives both lists; 'read' and 'bash' are each excluded by one of them.
    expect(plan.declaredBuiltinTools).toEqual(['write']);
  });

  it("does not let a denied 'subagent' tool through even when it is requested, so fan-out authority cannot be self-granted past a ceiling", () => {
    const plan = resolvePiLaunchToolPlan({
      tools: ['read', 'subagent'],
      capabilityCeiling: {
        version: 2,
        allowedTools: ['read'],
        allowedExternalProfiles: [],
        denyExtensions: false,
        sources: ['test'],
      },
    });

    expect(plan.declaredBuiltinTools).toEqual(['read']);
    expect(plan.fanoutAuthorized).toBe(false);
  });

  it("throws when 'subagent' is requested and not denied by any ceiling, because extension/fanout-child has not landed yet", () => {
    // Tracked separately: port-steering is porting extension/fanout-child next.
    // Until it lands, any launch that ends up fan-out-authorized cannot
    // resolve at all - this is the current, real behavior, not a gap this
    // test is quietly working around.
    expect(() => resolvePiLaunchToolPlan({ tools: ['read', 'subagent'] })).toThrow(/fanout-child/);
  });

  it('excludes every builtin tool when the ceiling has an empty allowedTools list, rather than treating empty as unset', () => {
    const plan = resolvePiLaunchToolPlan({
      tools: ['read', 'write'],
      capabilityCeiling: {
        version: 2,
        allowedTools: [],
        allowedExternalProfiles: [],
        denyExtensions: false,
        sources: ['test'],
      },
    });

    expect(plan.declaredBuiltinTools).toEqual([]);
    expect(plan.effectiveToolAllowlist).toEqual([]);
  });

  it('refuses the launch rather than silently dropping requireReadTool when a ceiling excludes read', () => {
    expect(() =>
      resolvePiLaunchToolPlan({
        tools: ['write'],
        requireReadTool: true,
        capabilityCeiling: {
          version: 2,
          allowedTools: ['write'],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['test'],
        },
      }),
    ).toThrow(/excludes required tool 'read'/);
  });

  it('adds read to a nonempty explicit list only when no ceiling is active', () => {
    const withoutCeiling = resolvePiLaunchToolPlan({ tools: ['write'], requireReadTool: true });
    expect(withoutCeiling.declaredBuiltinTools).toEqual(['read', 'write']);

    const withCeiling = resolvePiLaunchToolPlan({
      tools: ['read', 'write'],
      requireReadTool: true,
      capabilityCeiling: {
        version: 2,
        allowedTools: ['read'],
        allowedExternalProfiles: [],
        denyExtensions: false,
        sources: ['test'],
      },
    });
    expect(withCeiling.declaredBuiltinTools).toEqual(['read']);
  });

  it('rejects an explicit empty tool policy rather than widening it for configured skills', () => {
    expect(() => resolvePiLaunchToolPlan({ tools: [], requireReadTool: true })).toThrow(
      /allowlist excludes required tool 'read'/,
    );
  });

  it('requires a ceiling-constrained explicit list to request read rather than adding it', () => {
    expect(() =>
      resolvePiLaunchToolPlan({
        tools: ['write'],
        requireReadTool: true,
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read', 'write'],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['test'],
        },
      }),
    ).toThrow(/allowlist excludes required tool 'read'/);
  });

  describe('denyExtensions clamping', () => {
    it('empties every extension-shaped grant when the ceiling denies extensions, even with real MCP tools available to resolve', () => {
      const fixture = setUpMcpFixture();
      const plan = resolvePiLaunchToolPlan({
        tools: ['read', `${fixture.agentDir}/some-extension.ts`],
        mcpDirectTools: ['search'],
        mcpToolResolver: fixture.mcpToolResolver,
        capabilityCeiling: {
          version: 2,
          allowedTools: [],
          allowedExternalProfiles: [],
          denyExtensions: true,
          sources: ['test'],
        },
      });

      expect(plan.toolExtensionPaths).toEqual([]);
      expect(plan.resolvedMcpSelections).toEqual([]);
      expect(plan.effectiveMcpSelections).toEqual([]);
      expect(plan.effectiveMcpTools).toEqual([]);
      expect(plan.configuredExtensions).toEqual([]);
      expect(plan.disableAmbientExtensions).toBe(true);
      // Team prompt policy and the terminal cache runtime remain required.
      expect(plan.extensionArgs).toHaveLength(2);
      expect(plan.extensionArgs.at(-1)).toBe('@agimon-ai/doompi-cache/extensions/pi');
      expect(plan.capabilityAudit?.extensionsDenied).toBe(true);
    });

    it('does not deny extensions merely because a ceiling is present without denyExtensions set', () => {
      const plan = resolvePiLaunchToolPlan({
        tools: ['read'],
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read'],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['test'],
        },
      });

      expect(plan.disableAmbientExtensions).toBe(false);
      expect(plan.capabilityAudit?.extensionsDenied).toBe(false);
    });
  });

  describe('child tool exclusions', () => {
    it('removes excluded builtins and internal team tools after allowlist resolution', () => {
      const plan = resolvePiLaunchToolPlan({
        tools: ['read', 'ask_user_question', 'subagent'],
        excludeTools: ['ask_user_question', 'subagent', 'intercom'],
        teamToolEnabled: true,
      });

      expect(plan.excludedTools).toEqual(['ask_user_question', 'subagent', 'intercom']);
      expect(plan.declaredBuiltinTools).toEqual(['read']);
      expect(plan.internalTools).toEqual([]);
      expect(plan.effectiveToolAllowlist).toEqual(['read']);
      expect(plan.requiredChildTools).toEqual(['read']);
      expect(plan.fanoutAuthorized).toBe(false);
    });

    it('keeps the normal host tool set when exclusions are the only child policy', () => {
      const result = buildPiArgs(baseBuildInput({ excludeTools: ['ask_user_question', 'intercom', 'subagent'] }));

      expect(result.args).toEqual(expect.arrayContaining(['--exclude-tools', 'ask_user_question,intercom,subagent']));
      expect(result.args).not.toContain('--tools');
      expect(result.args).not.toContain('--no-tools');
      expect(result.sdk.excludeTools).toEqual(['ask_user_question', 'intercom', 'subagent']);
    });

    it('rejects exclusions that remove a required runtime tool', () => {
      expect(() => resolvePiLaunchToolPlan({ requireReadTool: true, excludeTools: ['read'] })).toThrow(
        /exclude required tool 'read'/,
      );
      expect(() => resolvePiLaunchToolPlan({ structuredOutput: true, excludeTools: ['structured_output'] })).toThrow(
        /exclude required tool 'structured_output'/,
      );
    });
  });

  describe('MCP direct tools: the host-tools vs. MCP-tools split', () => {
    it('resolves a real MCP selector to its host-prefixed name and adds it alongside, not instead of, the declared builtin tools', () => {
      const fixture = setUpMcpFixture();
      const plan = resolvePiLaunchToolPlan({
        tools: ['read'],
        mcpDirectTools: ['search'],
        mcpToolResolver: fixture.mcpToolResolver,
        cwd: fixture.agentDir,
      });

      expect(plan.effectiveMcpTools).toEqual([fixture.toolName]);
      expect(plan.resolvedMcpSelections).toEqual([{ name: fixture.toolName, selector: fixture.selector }]);
      // Both the host tool and the MCP tool are present; neither displaces the other.
      expect(plan.effectiveToolAllowlist).toEqual(['read', fixture.toolName]);
    });

    it('grants required Bash and all configured MCP tools when an active policy explicitly allows them', () => {
      const fixture = setUpMcpFixture();
      const plan = resolvePiLaunchToolPlan({
        tools: ['read'],
        cwd: fixture.agentDir,
        mcpToolResolver: fixture.mcpToolResolver,
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read', 'bash', 'mcp'],
          requiredTools: ['bash', 'mcp'],
          allowMcpTools: true,
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['@agimon-ai/doompi-plan'],
        },
      });

      expect(plan.declaredBuiltinTools).toEqual(['read', 'bash']);
      expect(plan.effectiveMcpTools).toEqual([fixture.toolName]);
      expect(plan.effectiveToolAllowlist).toEqual(['read', 'bash', fixture.toolName]);
      expect(plan.capabilityAudit?.requestedMcpToolCount).toBe(1);
    });

    it('filters a resolved MCP tool out of the allowlist when the ceiling does not name it, the same as any other tool', () => {
      const fixture = setUpMcpFixture();
      const plan = resolvePiLaunchToolPlan({
        tools: ['read'],
        mcpDirectTools: ['search'],
        mcpToolResolver: fixture.mcpToolResolver,
        cwd: fixture.agentDir,
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read'],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['test'],
        },
      });

      expect(plan.resolvedMcpSelections).toEqual([{ name: fixture.toolName, selector: fixture.selector }]);
      // Resolved, but filtered out of what the child actually receives.
      expect(plan.effectiveMcpSelections).toEqual([]);
      expect(plan.effectiveMcpTools).toEqual([]);
      expect(plan.effectiveToolAllowlist).toEqual(['read']);
    });

    it('keeps a resolved MCP tool when the ceiling names it explicitly', () => {
      const fixture = setUpMcpFixture();
      const plan = resolvePiLaunchToolPlan({
        tools: ['read'],
        mcpDirectTools: ['search'],
        mcpToolResolver: fixture.mcpToolResolver,
        cwd: fixture.agentDir,
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read', fixture.toolName],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['test'],
        },
      });

      expect(plan.effectiveMcpTools).toEqual([fixture.toolName]);
      expect(plan.effectiveToolAllowlist).toEqual(['read', fixture.toolName]);
    });

    it('resolves to nothing, without throwing, when there is no matching cached MCP metadata - the narrow failure direction', () => {
      const plan = resolvePiLaunchToolPlan({ tools: ['read'], mcpDirectTools: ['no-such-server'] });

      expect(plan.resolvedMcpSelections).toEqual([]);
      expect(plan.effectiveMcpTools).toEqual([]);
    });
  });

  describe('internalTools and declaredBuiltinTools composition (input.tools undefined vs. an explicit list)', () => {
    it('with tools undefined and no ceiling, declares no builtin tools and requires nothing, even though internal tools are still in the allowlist', () => {
      const plan = resolvePiLaunchToolPlan({ structuredOutput: true, teamToolEnabled: true });

      expect(plan.declaredBuiltinTools).toEqual([]);
      expect(plan.internalTools).toEqual(['structured_output', NATIVE_TEAM_TOOL_NAME]);
      expect(plan.effectiveToolAllowlist).toEqual(['structured_output', NATIVE_TEAM_TOOL_NAME]);
      // No explicit request was ever made ("whatever the host allows"), so
      // there is nothing to report as required of the child - pinning the
      // current, deliberate asymmetry at piArgs.ts's requiredChildTools.
      expect(plan.explicitToolAllowlist).toBe(false);
      expect(plan.requiredChildTools).toEqual([]);
    });

    it('with tools undefined but a ceiling present, declares exactly the ceiling as the builtin tool set', () => {
      const plan = resolvePiLaunchToolPlan({
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read', 'write'],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['test'],
        },
      });

      expect(plan.declaredBuiltinTools).toEqual(['read', 'write']);
      expect(plan.explicitToolAllowlist).toBe(true);
      // The ceiling narrows implicitly; nothing was explicitly requested, so
      // - as with the no-ceiling case above - the ceiling-derived tools are
      // not themselves reported as required.
      expect(plan.requiredChildTools).toEqual([]);
    });

    it('with an explicit tools list, requiredChildTools mirrors exactly what was declared, including internal tools', () => {
      const plan = resolvePiLaunchToolPlan({ tools: ['read'], structuredOutput: true });

      expect(plan.declaredBuiltinTools).toEqual(['read']);
      expect(plan.explicitToolAllowlist).toBe(true);
      expect(plan.requiredChildTools).toEqual(['read', 'structured_output']);
    });

    it('with an explicit empty tools list, still counts as an explicit allowlist of nothing, not "whatever the host allows"', () => {
      const plan = resolvePiLaunchToolPlan({ tools: [] });

      expect(plan.declaredBuiltinTools).toEqual([]);
      expect(plan.explicitToolAllowlist).toBe(true);
      expect(plan.effectiveToolAllowlist).toEqual([]);
    });
  });
});

describe('resolvePiSdkResourcePlan', () => {
  it('applies the inherited ceiling while preserving inherited harness resources', () => {
    const inheritedCeiling = {
      version: 2 as const,
      allowedTools: ['read'],
      allowedExternalProfiles: [],
      denyExtensions: true,
      sources: ['parent-plan'],
    };
    const environment: NodeJS.ProcessEnv = {
      [DOOMPI_CHILD_EXTENSIONS_ENV]: JSON.stringify(['/doom/guardrails.mjs']),
      [DOOMPI_SKILL_DIRS_ENV]: ['/doom/domain-a', '/doom/domain-b'].join(path.delimiter),
      [SUBAGENT_CAPABILITY_CEILING_ENV]: encodeSubagentCapabilityCeiling(inheritedCeiling),
    };

    const result = resolvePiSdkResourcePlan({
      tools: ['read', 'write'],
      extensions: ['/agent/extension.ts'],
      inheritSkills: true,
      environment,
    });

    expect(result.tools).toEqual(['read']);
    expect(result.noTools).toBeUndefined();
    expect(result.extensions).toContain('/doom/guardrails.mjs');
    expect(result.extensions).not.toContain('/agent/extension.ts');
    expect(result.extensionsProvidedExternally).toBe(true);
    expect(result.skillPaths).toEqual(['/doom/domain-a', '/doom/domain-b']);
    expect(result.toolPlan.capabilityCeiling?.sources).toEqual(['parent-plan']);
  });

  it('distinguishes unresolved host defaults from an explicit empty tool policy', () => {
    const hostDefaults = resolvePiSdkResourcePlan({ inheritSkills: true, environment: {} });
    const noTools = resolvePiSdkResourcePlan({ tools: [], inheritSkills: true, environment: {} });

    expect(hostDefaults.toolPlan.explicitToolAllowlist).toBe(false);
    expect(hostDefaults.tools).toBeUndefined();
    expect(hostDefaults.noTools).toBeUndefined();
    expect(hostDefaults.extensionsProvidedExternally).toBe(false);
    expect(noTools.toolPlan.explicitToolAllowlist).toBe(true);
    expect(noTools.tools).toBeUndefined();
    expect(noTools.noTools).toBe('all');
  });

  it('matches the resource settings consumed by buildPiArgs', () => {
    process.env[DOOMPI_CHILD_EXTENSIONS_ENV] = JSON.stringify(['/doom/guardrails.mjs']);
    process.env[DOOMPI_SKILL_DIRS_ENV] = '/doom/domain-a';
    const input = baseBuildInput({
      tools: ['read'],
      extensions: ['/agent/extension.ts'],
      excludeTools: ['write'],
    });

    const projected = resolvePiSdkResourcePlan({
      tools: input.tools,
      extensions: input.extensions,
      excludeTools: input.excludeTools,
      inheritSkills: input.inheritSkills,
    });
    const built = buildPiArgs(input);

    expect({
      tools: built.sdk.tools,
      noTools: built.sdk.noTools,
      excludeTools: built.sdk.excludeTools,
      extensions: built.sdk.extensions,
      extensionsProvidedExternally: built.sdk.extensionsProvidedExternally,
      noAmbientExtensions: built.sdk.noAmbientExtensions,
      skillPaths: built.sdk.skillPaths,
      noSkills: built.sdk.noSkills,
    }).toEqual({
      tools: projected.tools,
      noTools: projected.noTools,
      excludeTools: projected.excludeTools,
      extensions: projected.extensions,
      extensionsProvidedExternally: projected.extensionsProvidedExternally,
      noAmbientExtensions: projected.noAmbientExtensions,
      skillPaths: projected.skillPaths,
      noSkills: projected.noSkills,
    });
  });
});

describe('buildPiArgs - the cross-process env contract with src/env.ts', () => {
  it('inherits DoomPi child-safe extensions and domain skill directories into the SDK launch', () => {
    process.env[DOOMPI_CHILD_EXTENSIONS_ENV] = JSON.stringify(['/doom/layer.ts', '/doom/persona.ts']);
    process.env[DOOMPI_SKILL_DIRS_ENV] = ['/doom/domain-a', '/doom/domain-b'].join(path.delimiter);

    const result = buildPiArgs(baseBuildInput({ tools: ['read'], extensions: ['/agent/extension.ts'] }));

    expect(result.sdk.extensions).toEqual(
      expect.arrayContaining(['/doom/layer.ts', '/doom/persona.ts', '/agent/extension.ts']),
    );
    expect(result.sdk.skillPaths).toEqual(['/doom/domain-a', '/doom/domain-b']);
    expect(result.sdk.extensionsProvidedExternally).toBe(true);
    expect(result.sdk.noSkills).toBe(false);
  });

  it('deduplicates inherited guardrails with agent extensions while preserving first-seen order', () => {
    const guardrails = '/doom/agent-hooks.mjs';
    const vibeLint = '/doom/vibe-lint.mjs';
    const agentExtension = '/agent/extension.ts';
    process.env[DOOMPI_CHILD_EXTENSIONS_ENV] = JSON.stringify([guardrails, vibeLint, guardrails]);

    const result = buildPiArgs(baseBuildInput({ tools: ['read'], extensions: [vibeLint, agentExtension, guardrails] }));

    expect(result.sdk.extensions.filter((entry) => entry === guardrails)).toHaveLength(1);
    expect(result.sdk.extensions.filter((entry) => entry === vibeLint)).toHaveLength(1);
    expect(result.sdk.extensions.indexOf(guardrails)).toBeLessThan(result.sdk.extensions.indexOf(vibeLint));
    expect(result.sdk.extensions.indexOf(vibeLint)).toBeLessThan(result.sdk.extensions.indexOf(agentExtension));
  });

  it('keeps inherited harness guardrails explicit when the agent disables ambient extensions', () => {
    const guardrails = '/doom/agent-hooks.mjs';
    const vibeLint = '/doom/vibe-lint.mjs';
    process.env[DOOMPI_CHILD_EXTENSIONS_ENV] = JSON.stringify([guardrails, vibeLint]);

    const result = buildPiArgs(baseBuildInput({ tools: ['read'], extensions: [] }));

    expect(result.sdk.noAmbientExtensions).toBe(true);
    expect(result.sdk.extensions).toEqual(expect.arrayContaining([guardrails, vibeLint]));
  });

  it('keeps inherited harness guardrails when a capability ceiling denies agent extensions', () => {
    const guardrails = '/doom/agent-hooks.mjs';
    const vibeLint = '/doom/vibe-lint.mjs';
    process.env[DOOMPI_CHILD_EXTENSIONS_ENV] = JSON.stringify([guardrails, vibeLint]);

    const result = buildPiArgs(
      baseBuildInput({
        tools: ['read'],
        extensions: ['/agent/extension.ts'],
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read'],
          allowedExternalProfiles: [],
          denyExtensions: true,
          sources: ['test'],
        },
      }),
    );

    expect(result.sdk.noAmbientExtensions).toBe(true);
    expect(result.sdk.extensions).toEqual(expect.arrayContaining([guardrails, vibeLint]));
    expect(result.sdk.extensions).not.toContain('/agent/extension.ts');
    expect(result.sdk.extensions.at(-1)).toBe('@agimon-ai/doompi-cache/extensions/pi');
  });

  it('loads the cache runtime last and projects deterministic child cache state', () => {
    const cacheRuntime = '@agimon-ai/doompi-cache/extensions/pi';
    process.env[DOOMPI_CHILD_EXTENSIONS_ENV] = JSON.stringify(['/doom/team.mjs', cacheRuntime]);
    process.env[DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV] = 'dpn1_parent';
    process.env[DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV] = 'dpr1_root';
    const schema = {
      type: 'object' as const,
      properties: { answer: { type: 'string' as const } },
      required: ['answer'],
    };

    const result = buildPiArgs(
      baseBuildInput({
        tools: ['read'],
        excludeTools: ['write'],
        extensions: ['/agent/prompt-mutation.mjs'],
        systemPrompt: 'final child system prompt',
        inheritProjectContext: false,
        inheritSkills: true,
        structuredOutput: {
          schema,
          schemaPath: '/tmp/schema.json',
          outputPath: '/tmp/output.json',
        },
      }),
    );

    expect(result.sdk.extensions.at(-1)).toBe(cacheRuntime);
    expect(result.sdk.extensions.filter((extension) => extension === cacheRuntime)).toHaveLength(1);
    expect(result.env[DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV]).toBe('dpn1_parent');
    expect(result.env[DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV]).toBe('dpr1_root');
    expect(result.env[DOOMPI_PROMPT_CACHE_CHILD_PROJECTION_ENV]).toBe(
      createChildPromptCacheProjection(
        {
          systemPrompt: 'final child system prompt',
          tools: ['read', 'structured_output'],
          excludedTools: ['write'],
          extensions: result.sdk.extensions,
          inheritProjectContext: false,
          inheritSkills: true,
          fanout: false,
          structuredOutputSchema: schema,
        },
        sha256Base64Url,
      ),
    );
  });

  it('does not give domain skill directories to a child whose agent disables skill inheritance', () => {
    process.env[DOOMPI_SKILL_DIRS_ENV] = ['/doom/domain-a', '/doom/domain-b'].join(path.delimiter);

    const result = buildPiArgs(baseBuildInput({ tools: ['read'], inheritSkills: false }));

    expect(result.sdk.skillPaths).toEqual([]);
    expect(result.sdk.noSkills).toBe(true);
  });

  it('rejects malformed DoomPi child extension state instead of silently dropping parent behavior', () => {
    process.env[DOOMPI_CHILD_EXTENSIONS_ENV] = '{bad json';

    expect(() => buildPiArgs(baseBuildInput({ tools: ['read'] }))).toThrow(DOOMPI_CHILD_EXTENSIONS_ENV);
  });

  it('rejects non-string serialized child extensions instead of weakening inherited policy', () => {
    process.env[DOOMPI_CHILD_EXTENSIONS_ENV] = JSON.stringify(['/doom/agent-hooks.mjs', 42]);

    expect(() => buildPiArgs(baseBuildInput({ tools: ['read'] }))).toThrow(/JSON array of extension paths/);
  });

  it('writes every fan-out variable as the blanked empty string, never omitted, when fan-out was not authorized', () => {
    const result = buildPiArgs(baseBuildInput({ tools: ['read'] }));

    expect(result.env[SUBAGENT_CHILD_ENV]).toBe('1');
    expect(result.env[SUBAGENT_FANOUT_CHILD_ENV]).toBe('0');
    // Blanked (present, empty string), not omitted - omission would let a
    // value inherited from this process's own environment leak through.
    expect(result.env[SUBAGENT_PARENT_EVENT_SINK_ENV]).toBe('');
    expect(result.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV]).toBe('');
    expect(result.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]).toBe('');
    expect(result.env[SUBAGENT_PARENT_RUN_ID_ENV]).toBe('');
    expect(result.env[SUBAGENT_PARENT_CHILD_INDEX_ENV]).toBe('');
    expect(result.env[SUBAGENT_PARENT_DEPTH_ENV]).toBe('');
    expect(result.env[SUBAGENT_PARENT_PATH_ENV]).toBe('');
    expect(result.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]).toBe('');
  });

  it('forwards inherited workflow ancestry plus the parent process ids without removing Bash', () => {
    process.env[SUBAGENT_PROTECTED_PARENT_PIDS_ENV] = '[3101,3102,3101,1]';

    const result = buildPiArgs(baseBuildInput({ tools: ['read', 'bash'] }));
    const protectedProcessIds = JSON.parse(result.env[SUBAGENT_PROTECTED_PARENT_PIDS_ENV] ?? '[]') as number[];

    expect(protectedProcessIds).toEqual(
      [...new Set([3101, 3102, process.pid, process.ppid])].filter((pid) => Number.isSafeInteger(pid) && pid > 1),
    );
    expect(result.sdk.tools).toContain('bash');
    expect(result.sdk.excludeTools ?? []).not.toContain('bash');
  });

  it('blanks every fan-out variable even when this process itself inherited a full nested route, since fan-out was not re-granted to this child', () => {
    process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = 'inherited-sink';
    process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = 'inherited-root';
    process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = 'inherited-token';

    const result = buildPiArgs(baseBuildInput({ tools: ['read'] }));

    expect(result.env[SUBAGENT_PARENT_EVENT_SINK_ENV]).toBe('');
    expect(result.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]).toBe('');
    expect(result.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]).toBe('');
  });

  it("throws when the launch is fan-out authorized, because extension/fanout-child has not landed yet - buildPiArgs's own copy of the tracked gap", () => {
    expect(() => buildPiArgs(baseBuildInput({ tools: ['read', 'subagent'] }))).toThrow(/fanout-child/);
  });

  it('reflects inheritProjectContext and inheritSkills into their own env vars using the src/env.ts constants', () => {
    const result = buildPiArgs(baseBuildInput({ tools: ['read'], inheritProjectContext: false, inheritSkills: false }));

    expect(result.env[INHERIT_PROJECT_CONTEXT_ENV]).toBe('0');
    expect(result.env[INHERIT_SKILLS_ENV]).toBe('0');
  });

  it('writes the required-child-tools diagnostic only when there is something to require, keyed by the env.ts constants', () => {
    const withTools = buildPiArgs(baseBuildInput({ tools: ['read'] }));
    expect(withTools.env[REQUIRED_CHILD_TOOLS_ENV]).toBe(JSON.stringify(['read']));
    expect(withTools.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV]).toBeDefined();
    expect(withTools.toolDiagnosticPath).toBeDefined();

    const withoutTools = buildPiArgs(baseBuildInput());
    expect(withoutTools.env[REQUIRED_CHILD_TOOLS_ENV]).toBeUndefined();
    expect(withoutTools.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV]).toBeUndefined();
    expect(withoutTools.toolDiagnosticPath).toBeUndefined();
  });

  it('resolves MCP_DIRECT_TOOLS_ENV to the explicit "none" sentinel when there is nothing to select, not an omitted or empty key', () => {
    const result = buildPiArgs(baseBuildInput({ tools: ['read'] }));
    expect(result.env[MCP_DIRECT_TOOLS_ENV]).toBe(NO_MCP_DIRECT_TOOLS_SENTINEL);
  });

  it('passes the raw MCP selectors through MCP_DIRECT_TOOLS_ENV when there is no ceiling, and reports the resolved names separately via MCP_DIRECT_CHILD_TOOLS_ENV', () => {
    const fixture = setUpMcpFixture();
    const result = buildPiArgs(
      baseBuildInput({
        tools: ['read'],
        mcpDirectTools: ['search'],
        mcpToolResolver: fixture.mcpToolResolver,
        cwd: fixture.agentDir,
      }),
    );

    expect(result.env[MCP_DIRECT_TOOLS_ENV]).toBe('search');
    expect(result.env[MCP_DIRECT_CHILD_TOOLS_ENV]).toBe(JSON.stringify([fixture.toolName]));
  });

  // Under a ceiling the child is told the resolved selectors rather than the
  // caller's, so it registers exactly what survived filtering.
  it('narrows MCP_DIRECT_TOOLS_ENV to the surviving selectors when a ceiling is in force', () => {
    const fixture = setUpMcpFixture();
    const result = buildPiArgs(
      baseBuildInput({
        tools: ['read'],
        mcpDirectTools: ['search'],
        mcpToolResolver: fixture.mcpToolResolver,
        cwd: fixture.agentDir,
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read', fixture.toolName],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['test'],
        },
      }),
    );

    expect(result.env[MCP_DIRECT_TOOLS_ENV]).toBe(fixture.selector);
  });

  it('resolves to the none sentinel when a ceiling denies every selected MCP tool', () => {
    const fixture = setUpMcpFixture();
    const result = buildPiArgs(
      baseBuildInput({
        tools: ['read'],
        mcpDirectTools: ['search'],
        mcpToolResolver: fixture.mcpToolResolver,
        cwd: fixture.agentDir,
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read'],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['test'],
        },
      }),
    );

    expect(result.env[MCP_DIRECT_TOOLS_ENV]).toBe(NO_MCP_DIRECT_TOOLS_SENTINEL);
  });

  it('resolves to the none sentinel when a ceiling denies extensions outright', () => {
    const fixture = setUpMcpFixture();
    const result = buildPiArgs(
      baseBuildInput({
        tools: ['read'],
        mcpDirectTools: ['search'],
        mcpToolResolver: fixture.mcpToolResolver,
        cwd: fixture.agentDir,
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read', fixture.toolName],
          allowedExternalProfiles: [],
          denyExtensions: true,
          sources: ['test'],
        },
      }),
    );

    expect(result.env[MCP_DIRECT_TOOLS_ENV]).toBe(NO_MCP_DIRECT_TOOLS_SENTINEL);
  });

  it('encodes the effective capability ceiling into SUBAGENT_CAPABILITY_CEILING_ENV so a nested child can decode and further intersect it', () => {
    const result = buildPiArgs(
      baseBuildInput({
        tools: ['read'],
        capabilityCeiling: {
          version: 2,
          allowedTools: ['read', 'write'],
          allowedExternalProfiles: [],
          denyExtensions: false,
          sources: ['test'],
        },
      }),
    );

    const encoded = result.env[SUBAGENT_CAPABILITY_CEILING_ENV];
    expect(encoded).toBeDefined();
    expect(decodeSubagentCapabilityCeiling(encoded)).toMatchObject({ allowedTools: ['read', 'write'] });
  });

  it('does not write SUBAGENT_CAPABILITY_CEILING_ENV at all when there is no ceiling in force', () => {
    const result = buildPiArgs(baseBuildInput({ tools: ['read'] }));
    expect(result.env[SUBAGENT_CAPABILITY_CEILING_ENV]).toBeUndefined();
  });

  it('falls back to the empty string for SUBAGENT_PARENT_SESSION_ENV, never an inherited value, when no parent session id is given', () => {
    process.env[SUBAGENT_PARENT_SESSION_ENV] = 'leftover-from-this-process';
    const result = buildPiArgs(baseBuildInput({ tools: ['read'] }));
    // parentSessionId ?? process.env[...] ?? '' - an inherited value IS the
    // documented fallback here (unlike the fan-out vars above), so this pins
    // that this one path intentionally differs rather than by omission.
    expect(result.env[SUBAGENT_PARENT_SESSION_ENV]).toBe('leftover-from-this-process');
  });

  it('encodes one strictly typed child-process context when a parent session is present', () => {
    const result = buildPiArgs(
      baseBuildInput({
        tools: ['read'],
        parentSessionId: 'parent-session',
        cwd: '/repo',
        childAgentName: 'agiflow-dispatcher',
      }),
    );
    expect(readChildProcessContext(result.env)).toEqual({
      parentSessionId: 'parent-session',
      workingDirectory: '/repo',
      mode: 'agiflow-dispatcher',
    });
  });

  describe('tool budget: an encoded wire format a child decodes on the other side', () => {
    const budget: ResolvedToolBudget = { soft: 10, hard: 20, block: ['bash'] };

    it('encodes the budget into TOOL_BUDGET_ENV such that the real decoder round-trips it exactly', () => {
      const result = buildPiArgs(baseBuildInput({ tools: ['read'], toolBudget: budget }));

      const encoded = result.env[TOOL_BUDGET_ENV];
      expect(encoded).toBeDefined();
      expect(decodeToolBudgetEnv(encoded)).toEqual(budget);
    });

    it('writes nothing to TOOL_BUDGET_ENV when no budget is given, rather than an empty or undefined-shaped value', () => {
      const result = buildPiArgs(baseBuildInput({ tools: ['read'] }));
      expect(result.env[TOOL_BUDGET_ENV]).toBeUndefined();
      // The real decoder's own contract for "no budget was set".
      expect(decodeToolBudgetEnv(result.env[TOOL_BUDGET_ENV])).toBeUndefined();
    });

    it('writes TOOL_BUDGET_ZERO_AUTH_ENV only when explicitly authorized, never merely because a budget with a zero hard limit exists', () => {
      const authorized = buildPiArgs(baseBuildInput({ tools: ['read'], allowZeroToolBudget: true }));
      expect(authorized.env[TOOL_BUDGET_ZERO_AUTH_ENV]).toBe('1');

      const notAuthorized = buildPiArgs(baseBuildInput({ tools: ['read'], toolBudget: { hard: 0, block: '*' } }));
      expect(notAuthorized.env[TOOL_BUDGET_ZERO_AUTH_ENV]).toBeUndefined();
    });
  });

  describe('structured output and steer path passthrough env vars', () => {
    it('writes the structured-output schema and capture paths verbatim when structured output is requested', () => {
      const result = buildPiArgs(
        baseBuildInput({
          tools: ['read'],
          structuredOutput: {
            schema: { type: 'object' },
            schemaPath: '/tmp/schema.json',
            outputPath: '/tmp/output.json',
          },
        }),
      );

      expect(result.env[STRUCTURED_OUTPUT_SCHEMA_ENV]).toBe('/tmp/schema.json');
      expect(result.env[STRUCTURED_OUTPUT_CAPTURE_ENV]).toBe('/tmp/output.json');
    });

    it('writes nothing to either structured-output env var when it was not requested', () => {
      const result = buildPiArgs(baseBuildInput({ tools: ['read'] }));

      expect(result.env[STRUCTURED_OUTPUT_SCHEMA_ENV]).toBeUndefined();
      expect(result.env[STRUCTURED_OUTPUT_CAPTURE_ENV]).toBeUndefined();
    });

    it('writes each steer path only when its own input field is given, independently of the other two', () => {
      const result = buildPiArgs(
        baseBuildInput({
          tools: ['read'],
          steerInboxDir: '/tmp/steer-inbox',
          steerCapabilityPath: '/tmp/steer-capability.json',
          steerAckDir: '/tmp/steer-ack',
        }),
      );

      expect(result.env[SUBAGENT_STEER_INBOX_ENV]).toBe('/tmp/steer-inbox');
      expect(result.env[SUBAGENT_STEER_CAPABILITY_ENV]).toBe('/tmp/steer-capability.json');
      expect(result.env[SUBAGENT_STEER_ACK_DIR_ENV]).toBe('/tmp/steer-ack');

      const partial = buildPiArgs(baseBuildInput({ tools: ['read'], steerInboxDir: '/tmp/steer-inbox' }));
      expect(partial.env[SUBAGENT_STEER_INBOX_ENV]).toBe('/tmp/steer-inbox');
      expect(partial.env[SUBAGENT_STEER_CAPABILITY_ENV]).toBeUndefined();
      expect(partial.env[SUBAGENT_STEER_ACK_DIR_ENV]).toBeUndefined();
    });
  });
});
