import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionConfig } from '../../src/adapters/pi/extensions/config';
import {
  captureSessionForkSource,
  type SessionForkSource,
  SpawnPlanner,
  type SpawnPlanRequest,
} from '../../src/adapters/pi/extensions/spawnPlan';
import { SubagentCapabilityPolicyStore } from '../../src/schemas/team/capabilityCeiling';
import { AdmissionGate } from '../../src/adapters/runs/shared/admissionGate';
import type {
  DiscoveredSkill,
  SkillDiscoveryContract,
  SkillLocation,
  SkillResolution,
} from '../../src/adapters/agents/skills';
import type {
  AgentConfig,
  AgentDiscoveryResult,
  AgentScope,
  AgentDiscoveryContract,
} from '../../src/adapters/agents/types';
import type {
  AsyncSubagentSpawnInput,
  AsyncSubagentSpawnResult,
  AsyncSubagentSpawnerContract,
} from '../../src/adapters/runs/background/asyncExecution';

function agentConfig(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: `test agent ${name}`,
    systemPromptMode: 'append',
    inheritProjectContext: true,
    inheritSkills: true,
    systemPrompt: `You are ${name}.`,
    source: 'user',
    filePath: `/agents/${name}.md`,
    ...overrides,
  };
}

class FakeAgentDiscovery implements AgentDiscoveryContract {
  agents = new Map<string, AgentConfig>();
  findCalls: Array<{ cwd: string; scope: AgentScope; name: string }> = [];

  find(cwd: string, scope: AgentScope, name: string): AgentConfig | undefined {
    this.findCalls.push({ cwd, scope, name });
    return this.agents.get(name);
  }
  discover(): AgentDiscoveryResult {
    return { agents: [...this.agents.values()], projectAgentsDir: null };
  }
  invalidate(): void {}
}

class FakeSkillDiscovery implements SkillDiscoveryContract {
  calls: Array<{
    skillNames: string[];
    primaryCwd: string;
    fallbackCwd?: string;
    localSkillPaths?: string[];
    localBaseDir?: string;
  }> = [];
  resolutions = new Map<string, SkillResolution>();

  resolveSkillPath(): SkillLocation | undefined {
    return undefined;
  }

  resolveSkills(skillNames: string[]): SkillResolution {
    return this.resolutionFor(skillNames);
  }

  resolveSkillsWithFallback(
    skillNames: string[],
    primaryCwd: string,
    fallbackCwd?: string,
    localSkillPaths?: string[],
    localBaseDir?: string,
  ): SkillResolution {
    this.calls.push({ skillNames, primaryCwd, fallbackCwd, localSkillPaths, localBaseDir });
    return this.resolutionFor(skillNames);
  }

  discoverAvailableSkills(): DiscoveredSkill[] {
    return [];
  }

  invalidate(): void {}

  private resolutionFor(skillNames: string[]): SkillResolution {
    const resolution = this.resolutions.get(skillNames.join(',')) ?? { resolved: [], missing: [...skillNames] };
    return { resolved: [...resolution.resolved], missing: [...resolution.missing] };
  }
}

class FakeSpawner implements AsyncSubagentSpawnerContract {
  calls: AsyncSubagentSpawnInput[] = [];
  /** Keyed by agent name; a missing entry falls back to a generic success. */
  results = new Map<string, AsyncSubagentSpawnResult | Error>();

  async spawn(input: AsyncSubagentSpawnInput): Promise<AsyncSubagentSpawnResult> {
    this.calls.push(input);
    const outcome = this.results.get(input.agent);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { runId: input.runId, pid: 1000 + this.calls.length };
  }
}

/** Spawn planner with deterministic run ids (`run-0`, `run-1`, ...). */
class TestableSpawnPlanner extends SpawnPlanner {
  private nextRunId = 0;
  teamPackageExcludeTools: string[] | undefined;
  teamPackageModels: string[] | undefined;
  forkSources: SessionForkSource[] = [];
  removedSessionFiles: string[] = [];
  failForkAt: number | undefined;

  protected override generateRunId(): string {
    const id = `run-${this.nextRunId}`;
    this.nextRunId += 1;
    return id;
  }

  protected override resolveTeamPackageExcludeTools(): string[] | undefined {
    return this.teamPackageExcludeTools;
  }

  protected override resolveTeamPackageModels(): string[] | undefined {
    return this.teamPackageModels;
  }

  protected override validateCwd(): void {}

  protected override executableAvailable(): boolean {
    return true;
  }

  protected override createForkSessionFile(source: SessionForkSource): string {
    this.forkSources.push(source);
    if (this.forkSources.length === this.failForkAt) throw new Error('fork preparation failed');
    return `/tmp/fork-${this.forkSources.length}.jsonl`;
  }

  protected override removePreparedSessionFile(sessionFile: string): void {
    this.removedSessionFiles.push(sessionFile);
  }
}

const temporaryDirectories: string[] = [];

function readableForkSource(leafId = 'parent-leaf'): SessionForkSource {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-fork-'));
  temporaryDirectories.push(directory);
  const sessionFile = path.join(directory, 'parent.jsonl');
  fs.writeFileSync(sessionFile, '{}\n');
  return { sessionFile, leafId };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function baseRequest(overrides: Partial<SpawnPlanRequest> = {}): SpawnPlanRequest {
  return {
    cwd: '/work',
    agentScope: 'both',
    currentDepth: 0,
    ...overrides,
  };
}

describe('SpawnPlanner', () => {
  let discovery: FakeAgentDiscovery;
  let spawner: FakeSpawner;
  let skills: FakeSkillDiscovery;
  let planner: TestableSpawnPlanner;
  let config: ExtensionConfig;

  beforeEach(() => {
    discovery = new FakeAgentDiscovery();
    spawner = new FakeSpawner();
    skills = new FakeSkillDiscovery();
    planner = new TestableSpawnPlanner(discovery, spawner, undefined, skills);
    config = {};
  });

  describe('request shape validation', () => {
    it('throws when neither single nor tasks is provided', async () => {
      await expect(planner.spawn(baseRequest(), config)).rejects.toThrow(/\[invalid_request\].*exactly one/);
    });

    it('throws when both single and tasks are provided', async () => {
      discovery.agents.set('worker', agentConfig('worker'));
      await expect(
        planner.spawn(
          baseRequest({ single: { agent: 'worker', task: 'x' }, tasks: [{ agent: 'worker', task: 'y' }] }),
          config,
        ),
      ).rejects.toThrow(/exactly one of/);
    });

    it('throws when tasks is an empty array', async () => {
      await expect(planner.spawn(baseRequest({ tasks: [] }), config)).rejects.toThrow(/at least one entry/);
    });

    it('none of these preflight failures call the spawner at all', async () => {
      await expect(planner.spawn(baseRequest(), config)).rejects.toThrow();
      expect(spawner.calls).toHaveLength(0);
    });
  });

  describe('SINGLE mode', () => {
    it('spawns exactly one child at childIndex 0, fanout=false', async () => {
      discovery.agents.set('worker', agentConfig('worker'));

      const result = await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'do the thing' } }), config);

      expect(spawner.calls).toHaveLength(1);
      expect(spawner.calls[0]).toMatchObject({ agent: 'worker', task: 'do the thing', childIndex: 0, fanout: false });
      expect(result.outcomes).toEqual([
        { agent: 'worker', task: 'do the thing', childIndex: 0, runId: spawner.calls[0]!.runId, pid: 1001 },
      ]);
      expect(skills.calls).toEqual([]);
    });

    it('resolves agent defaults (systemPrompt, inheritProjectContext, inheritSkills, systemPromptMode) into piArgs', async () => {
      discovery.agents.set(
        'reviewer',
        agentConfig('reviewer', { inheritProjectContext: false, inheritSkills: false, systemPromptMode: 'replace' }),
      );

      await planner.spawn(baseRequest({ single: { agent: 'reviewer', task: 'review' } }), config);

      expect(spawner.calls[0]?.piArgs).toMatchObject({
        inheritProjectContext: false,
        inheritSkills: false,
        systemPromptMode: 'replace',
        systemPrompt: 'You are reviewer.',
      });
    });

    it('injects resolved skill metadata from request-relative roots without embedding bodies', async () => {
      const skillPath = '/request/configured-skills/code-review/SKILL.md';
      skills.resolutions.set('code-review', {
        resolved: [
          {
            name: 'code-review',
            description: 'Review code safely',
            path: skillPath,
            content: 'PRIVATE_SKILL_BODY',
            source: 'project',
          },
        ],
        missing: [],
      });
      discovery.agents.set(
        'reviewer',
        agentConfig('reviewer', {
          inheritSkills: false,
          skills: ['code-review'],
          skillPath: ['./configured-skills'],
        }),
      );

      await planner.spawn(
        baseRequest({ cwd: '/request', single: { agent: 'reviewer', task: 'review', cwd: '/child' } }),
        config,
      );

      expect(skills.calls).toEqual([
        {
          skillNames: ['code-review'],
          primaryCwd: '/child',
          fallbackCwd: '/request',
          localSkillPaths: ['./configured-skills'],
          localBaseDir: '/request',
        },
      ]);
      expect(spawner.calls[0]?.piArgs).toMatchObject({
        inheritSkills: false,
        requireReadTool: true,
        systemPromptMode: 'append',
      });
      const prompt = spawner.calls[0]?.piArgs.systemPrompt ?? '';
      expect(prompt).toContain('You are reviewer.\n\nThe following configured skills');
      expect(prompt).toContain('<name>code-review</name>');
      expect(prompt).toContain('<description>Review code safely</description>');
      expect(prompt).toContain(`<location>${skillPath}</location>`);
      expect(prompt).not.toContain('PRIVATE_SKILL_BODY');
    });

    it('memoizes equivalent sibling agent and configured-skill resolution within one spawn', async () => {
      skills.resolutions.set('shared-skill', {
        resolved: [
          {
            name: 'shared-skill',
            path: '/skills/shared-skill/SKILL.md',
            content: 'PRIVATE_BODY',
            source: 'project',
          },
        ],
        missing: [],
      });
      discovery.agents.set('worker', agentConfig('worker', { skills: ['shared-skill'] }));
      const tasks = Array.from({ length: 8 }, (_, index) => ({ agent: 'worker', task: `task ${index}` }));

      await planner.spawn(baseRequest({ tasks }), { parallel: { maxTasks: 8, concurrency: 8 } });

      expect(discovery.findCalls).toHaveLength(1);
      expect(skills.calls).toHaveLength(1);
      expect(spawner.calls).toHaveLength(8);
      expect(spawner.calls.every((call) => call.piArgs.systemPrompt?.includes('<name>shared-skill</name>'))).toBe(true);
    });

    it('injects deduplicated existing defaultReads and warns without failing for missing paths', async () => {
      const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-default-reads-'));
      temporaryDirectories.push(childCwd);
      const readPath = path.join(childCwd, 'README.md');
      const missingPath = path.join(childCwd, 'missing.md');
      fs.writeFileSync(readPath, '# Context\n');
      discovery.agents.set(
        'reader',
        agentConfig('reader', { defaultReads: ['README.md', './README.md', 'missing.md'] }),
      );

      const result = await planner.spawn(
        baseRequest({ single: { agent: 'reader', task: 'inspect', cwd: childCwd } }),
        config,
      );

      expect(spawner.calls[0]?.piArgs.requireReadTool).toBe(true);
      expect(spawner.calls[0]?.piArgs.systemPrompt?.match(new RegExp(readPath, 'g'))).toHaveLength(1);
      expect(spawner.calls[0]?.piArgs.systemPrompt).toContain('before broad repository discovery');
      expect(spawner.calls[0]?.task).toBe('inspect');
      expect(result.outcomes[0]?.warning).toContain(`could not read optional default paths: ${missingPath}`);
    });

    it('preserves replace prompt mode while appending configured skill metadata', async () => {
      skills.resolutions.set('replacement', {
        resolved: [
          {
            name: 'replacement',
            description: 'Replacement metadata',
            path: '/skills/replacement/SKILL.md',
            content: 'REPLACEMENT_BODY',
            source: 'user',
          },
        ],
        missing: [],
      });
      discovery.agents.set(
        'replacer',
        agentConfig('replacer', {
          systemPrompt: 'Replacement instructions.',
          systemPromptMode: 'replace',
          skills: ['replacement'],
        }),
      );

      await planner.spawn(baseRequest({ single: { agent: 'replacer', task: 'replace' } }), config);

      expect(spawner.calls[0]?.piArgs.systemPromptMode).toBe('replace');
      expect(spawner.calls[0]?.piArgs.systemPrompt).toContain(
        'Replacement instructions.\n\nThe following configured skills',
      );
      expect(spawner.calls[0]?.piArgs.systemPrompt).not.toContain('REPLACEMENT_BODY');
    });

    it('creates a one-shot read-only inline agent without consulting discovery or skill resolution', async () => {
      await planner.spawn(
        baseRequest({
          single: {
            agent: 'schema-explorer',
            inlineAgent: { systemPrompt: 'Inspect schema boundaries.' },
            task: 'Review schemas',
          },
        }),
        config,
      );

      expect(discovery.findCalls).toEqual([]);
      expect(skills.calls).toEqual([]);
      expect(spawner.calls[0]).toMatchObject({
        agent: 'schema-explorer',
        inlineAgent: { systemPrompt: 'Inspect schema boundaries.' },
        runtime: 'pi',
      });
      expect(spawner.calls[0]?.piArgs).toMatchObject({
        sessionEnabled: true,
        systemPrompt: 'Inspect schema boundaries.',
        systemPromptMode: 'append',
        inheritProjectContext: true,
        inheritSkills: false,
        tools: ['read', 'grep', 'find', 'ls'],
      });
    });

    it('passes Team package exclusions to discovered and inline children', async () => {
      planner.teamPackageExcludeTools = ['ask_user_question', 'intercom', 'subagent'];
      discovery.agents.set('worker', agentConfig('worker'));

      await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'inspect' } }), config);
      await planner.spawn(
        baseRequest({
          single: {
            agent: 'inline-worker',
            inlineAgent: { systemPrompt: 'Inspect only.' },
            task: 'inspect inline',
          },
        }),
        config,
      );

      expect(spawner.calls.map((call) => call.piArgs.excludeTools)).toEqual([
        ['ask_user_question', 'intercom', 'subagent'],
        ['ask_user_question', 'intercom', 'subagent'],
      ]);
    });

    it('warns and launches external runtimes without claiming Pi-resource parity', async () => {
      planner.teamPackageExcludeTools = ['ask_user_question', 'intercom', 'subagent'];
      discovery.agents.set(
        'external',
        agentConfig('external', {
          runtime: 'claude',
          tools: ['read'],
          skills: ['unit-testing'],
          extensions: ['/ext/external.ts'],
        }),
      );

      const result = await planner.spawn(baseRequest({ single: { agent: 'external', task: 'inspect' } }), config);

      expect(result.outcomes[0]?.runId).toBeDefined();
      expect(result.outcomes[0]?.warning).toContain('does not load Pi child extensions or hooks');
      expect(result.outcomes[0]?.warning).toContain(
        'cannot project or enforce configured Pi tools, skills, extensions',
      );
      expect(result.outcomes[0]?.warning).toContain('Configured skills were not injected: unit-testing');
      expect(result.outcomes[0]?.warning).toContain('cannot enforce Team package tool exclusions');
      expect(skills.calls).toEqual([]);
    });

    it('persists fresh Pi sessions but leaves external runtime session policy unchanged', async () => {
      discovery.agents.set('pi-worker', agentConfig('pi-worker'));
      discovery.agents.set('external', agentConfig('external', { runtime: 'claude' }));

      await planner.spawn(baseRequest({ single: { agent: 'pi-worker', task: 'inspect' } }), config);
      await planner.spawn(baseRequest({ single: { agent: 'external', task: 'inspect' } }), config);

      expect(spawner.calls[0]?.piArgs.sessionEnabled).toBe(true);
      expect(spawner.calls[1]?.piArgs.sessionEnabled).toBe(false);
    });

    it('applies the typed session policy at the central spawn boundary', async () => {
      discovery.agents.set('reviewer', agentConfig('reviewer', { tools: ['read', 'write'] }));
      const policies = new SubagentCapabilityPolicyStore();
      policies.register(
        { owner: '@agimon-ai/doompi-plan', allowedTools: ['read'], denyExtensions: true },
        'plan-generation',
      );
      planner = new TestableSpawnPlanner(discovery, spawner, policies, skills);

      await planner.spawn(baseRequest({ single: { agent: 'reviewer', task: 'review' } }), config);

      expect(spawner.calls[0]?.piArgs.capabilityCeiling).toEqual({
        version: 2,
        allowedTools: ['read'],
        allowedExternalProfiles: [],
        denyExtensions: true,
        sources: ['@agimon-ai/doompi-plan'],
      });
    });

    it('rejects external runtimes while a capability ceiling is active', async () => {
      discovery.agents.set('external', agentConfig('external', { runtime: 'claude' }));
      const policies = new SubagentCapabilityPolicyStore();
      policies.register({ owner: '@agimon-ai/doompi-plan', allowedTools: ['read'] }, 'plan-generation');
      planner = new TestableSpawnPlanner(discovery, spawner, policies, skills);

      await expect(
        planner.spawn(baseRequest({ single: { agent: 'external', task: 'review' } }), config),
      ).rejects.toThrow(/cannot enforce the active capability ceiling/);
      expect(spawner.calls).toEqual([]);
    });

    it('a task-level model override wins over the agent default', async () => {
      discovery.agents.set('worker', agentConfig('worker', { model: 'agent-default-model' }));

      await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'x', model: 'override-model' } }), config);

      expect(spawner.calls[0]?.piArgs.model).toBe('override-model');
    });

    it("falls back to the agent's own model when no override is given", async () => {
      discovery.agents.set('worker', agentConfig('worker', { model: 'agent-default-model' }));

      await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'x' } }), config);

      expect(spawner.calls[0]?.piArgs.model).toBe('agent-default-model');
    });

    it('tries agent config, team fallbacks, then parent config for Pi children', async () => {
      discovery.agents.set(
        'worker',
        agentConfig('worker', {
          model: 'anthropic/agent-primary',
          fallbackModels: ['anthropic/agent-fallback'],
        }),
      );
      planner.teamPackageModels = ['openai-codex/gpt-5.6-luna:xhigh', 'openai-codex/gpt-5.6-luna:high'];

      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'x' },
          parentModel: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
          availableModels: [
            {
              provider: 'openai-codex',
              id: 'gpt-5.6-sol',
              fullId: 'openai-codex/gpt-5.6-sol',
            },
            {
              provider: 'openai-codex',
              id: 'gpt-5.6-luna',
              fullId: 'openai-codex/gpt-5.6-luna',
            },
          ],
        }),
        config,
      );

      expect(spawner.calls[0]?.piArgs.model).toBe('openai-codex/gpt-5.6-luna:xhigh');
    });

    it('uses parent config only after agent and team candidates are unavailable', async () => {
      discovery.agents.set('worker', agentConfig('worker', { model: 'anthropic/agent-default-model' }));
      planner.teamPackageModels = ['anthropic/team-default-model'];

      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'x' },
          parentModel: { provider: 'openai-codex', id: 'gpt-5.6-luna' },
          availableModels: [
            {
              provider: 'openai-codex',
              id: 'gpt-5.6-luna',
              fullId: 'openai-codex/gpt-5.6-luna',
            },
          ],
        }),
        config,
      );

      expect(spawner.calls[0]?.piArgs.model).toBe('openai-codex/gpt-5.6-luna');
    });

    it('does not duplicate a team model inherited through discovery', async () => {
      discovery.agents.set(
        'worker',
        agentConfig('worker', {
          model: 'openai-codex/gpt-5.6-luna:xhigh',
          modelSource: {
            type: 'packages.team.defaultModel',
            scope: 'package',
            path: '/repo/.doom/modes.yaml',
            model: 'openai-codex/gpt-5.6-luna:xhigh',
          },
        }),
      );
      planner.teamPackageModels = ['openai-codex/gpt-5.6-luna:xhigh'];

      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'x' },
          parentModel: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
          availableModels: [
            {
              provider: 'openai-codex',
              id: 'gpt-5.6-luna',
              fullId: 'openai-codex/gpt-5.6-luna',
            },
          ],
        }),
        config,
      );

      expect(spawner.calls[0]?.piArgs.model).toBe('openai-codex/gpt-5.6-luna:xhigh');
    });

    it('does not inherit a parent model for external runtimes', async () => {
      discovery.agents.set('external', agentConfig('external', { runtime: 'claude', model: 'agent-default-model' }));

      await planner.spawn(
        baseRequest({
          single: { agent: 'external', task: 'x' },
          parentModel: { provider: 'openai-codex', id: 'gpt-5.6-luna' },
          availableModels: [
            {
              provider: 'openai-codex',
              id: 'gpt-5.6-luna',
              fullId: 'openai-codex/gpt-5.6-luna',
            },
            {
              provider: 'anthropic',
              id: 'agent-default-model',
              fullId: 'anthropic/agent-default-model',
            },
          ],
        }),
        config,
      );

      expect(spawner.calls[0]?.piArgs.model).toBe('anthropic/agent-default-model');
    });

    it('skips an unavailable primary model and launches with the first authenticated fallback', async () => {
      discovery.agents.set(
        'worker',
        agentConfig('worker', {
          model: 'anthropic/claude-sonnet-4-6:high',
          fallbackModels: ['openai-codex/gpt-5.6-luna:low'],
        }),
      );

      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'x' },
          availableModels: [
            {
              provider: 'openai-codex',
              id: 'gpt-5.6-luna',
              fullId: 'openai-codex/gpt-5.6-luna',
            },
          ],
        }),
        config,
      );

      expect(spawner.calls[0]?.piArgs.model).toBe('openai-codex/gpt-5.6-luna:low');
    });

    it('does not launch when none of the configured model candidates is authenticated', async () => {
      discovery.agents.set(
        'worker',
        agentConfig('worker', {
          model: 'anthropic/claude-sonnet-4-6',
          fallbackModels: ['openai-codex/gpt-5.6-luna'],
        }),
      );

      await expect(
        planner.spawn(baseRequest({ single: { agent: 'worker', task: 'x' }, availableModels: [] }), config),
      ).rejects.toThrow(/\[model_unavailable\].*No authenticated model is available/);
      expect(spawner.calls).toHaveLength(0);
    });

    it('throws naming the missing agent, before spawning anything, for an unknown agent', async () => {
      await expect(planner.spawn(baseRequest({ single: { agent: 'ghost', task: 'x' } }), config)).rejects.toThrow(
        /'ghost'/,
      );
      expect(spawner.calls).toHaveLength(0);
    });

    it("rejects unavailable 'fork' context before spawning", async () => {
      discovery.agents.set('worker', agentConfig('worker'));

      await expect(
        planner.spawn(
          baseRequest({
            single: { agent: 'worker', task: 'x', context: 'fork' },
            parentSessionId: 'parent-session-1',
          }),
          config,
        ),
      ).rejects.toThrow(/Fork context is unavailable/);

      expect(spawner.calls).toHaveLength(0);
    });

    it("forwards the parent session file without parent lineage for 'fresh' context", async () => {
      discovery.agents.set('worker', agentConfig('worker'));
      const parentSessionFile = '/home/u/.pi/agent/sessions/parent/transcript.jsonl';

      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'x', context: 'fresh' },
          parentSessionId: 'parent-session-1',
          parentSessionFile,
        }),
        config,
      );

      expect(spawner.calls[0]?.parentSessionFile).toBe(parentSessionFile);
      expect(spawner.calls[0]?.piArgs.parentSessionId).toBeUndefined();
    });

    it("rejects an agent's fork default when the parent source is unavailable", async () => {
      discovery.agents.set('worker', agentConfig('worker', { defaultContext: 'fork' }));

      await expect(
        planner.spawn(
          baseRequest({ single: { agent: 'worker', task: 'x' }, parentSessionId: 'parent-session-1' }),
          config,
        ),
      ).rejects.toThrow(/Fork context is unavailable/);

      expect(spawner.calls).toHaveLength(0);
    });

    it('a per-child spawn failure is returned as an {error} outcome, not thrown', async () => {
      discovery.agents.set('worker', agentConfig('worker'));
      spawner.results.set('worker', new Error('spawn exploded'));

      const result = await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'x' } }), config);

      expect(result.outcomes).toEqual([{ agent: 'worker', task: 'x', childIndex: 0, error: 'spawn exploded' }]);
    });
  });

  describe('fork context', () => {
    it('projects the same configured skills for fresh and fork launches', async () => {
      skills.resolutions.set('shared-skill', {
        resolved: [
          {
            name: 'shared-skill',
            description: 'Shared metadata',
            path: '/skills/shared/SKILL.md',
            content: 'SHARED_BODY',
            source: 'project',
          },
        ],
        missing: [],
      });
      discovery.agents.set('worker', agentConfig('worker', { skills: ['shared-skill'] }));
      const source = readableForkSource();

      await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'fresh', context: 'fresh' } }), config);
      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'fork', context: 'fork' },
          parentSessionFile: source.sessionFile,
          parentLeafId: source.leafId,
        }),
        config,
      );

      expect(skills.calls).toHaveLength(2);
      expect(spawner.calls.map((call) => call.piArgs.requireReadTool)).toEqual([true, true]);
      expect(spawner.calls[0]?.piArgs.systemPrompt).toBe(spawner.calls[1]?.piArgs.systemPrompt);
    });

    it('clones a valid explicit fork and forwards its parent lineage', async () => {
      discovery.agents.set('worker', agentConfig('worker'));
      const source = readableForkSource();

      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'x', context: 'fork' },
          parentSessionId: 'parent-session',
          parentSessionFile: source.sessionFile,
          parentLeafId: source.leafId,
        }),
        config,
      );

      expect(planner.forkSources).toEqual([source]);
      expect(spawner.calls[0]).toMatchObject({
        parentSessionFile: source.sessionFile,
        piArgs: {
          sessionFile: '/tmp/fork-1.jsonl',
          parentSessionId: 'parent-session',
        },
      });
    });

    it('honors an agent default fork while an explicit fresh override stays independent', async () => {
      discovery.agents.set('worker', agentConfig('worker', { defaultContext: 'fork' }));
      const source = readableForkSource();

      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'x' },
          parentSessionFile: source.sessionFile,
          parentLeafId: source.leafId,
        }),
        config,
      );
      expect(spawner.calls[0]?.piArgs.sessionFile).toBe('/tmp/fork-1.jsonl');

      planner = new TestableSpawnPlanner(discovery, spawner);
      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'x', context: 'fresh' },
          parentSessionFile: source.sessionFile,
          parentLeafId: source.leafId,
        }),
        config,
      );
      expect(planner.forkSources).toEqual([]);
      expect(spawner.calls[1]?.piArgs.sessionFile).toBeUndefined();
    });

    it('rejects external-runtime forks before preparing or spawning', async () => {
      discovery.agents.set('worker', agentConfig('worker'));
      const source = readableForkSource();

      await expect(
        planner.spawn(
          baseRequest({
            single: { agent: 'worker', task: 'x', context: 'fork', runtime: 'claude' },
            parentSessionFile: source.sessionFile,
            parentLeafId: source.leafId,
          }),
          config,
        ),
      ).rejects.toThrow(/Fork context requires runtime "pi"/);

      expect(planner.forkSources).toEqual([]);
      expect(spawner.calls).toEqual([]);
    });

    it('prepares isolated files for parallel forks from the same source', async () => {
      discovery.agents.set('worker', agentConfig('worker'));
      const source = readableForkSource();

      await planner.spawn(
        baseRequest({
          tasks: [
            { agent: 'worker', task: 'a', context: 'fork' },
            { agent: 'worker', task: 'b', context: 'fork' },
          ],
          parentSessionFile: source.sessionFile,
          parentLeafId: source.leafId,
        }),
        config,
      );

      expect(planner.forkSources).toEqual([source, source]);
      expect(spawner.calls.map((call) => call.piArgs.sessionFile)).toEqual(['/tmp/fork-1.jsonl', '/tmp/fork-2.jsonl']);
    });

    it('keeps parallel fork clones isolated while leaving the parent transcript immutable', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-parallel-fork-'));
      temporaryDirectories.push(directory);
      const parent = SessionManager.create(directory, directory);
      const parentLeafId = parent.appendMessage({ role: 'user', content: 'shared parent context', timestamp: 1 });
      parent.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'settled parent response' }],
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 2,
      });
      const parentSessionFile = parent.getSessionFile()!;
      const parentBefore = fs.readFileSync(parentSessionFile);
      discovery.agents.set('worker', agentConfig('worker'));
      const realPlanner = new SpawnPlanner(discovery, spawner);

      await realPlanner.spawn(
        {
          tasks: [
            { agent: 'worker', task: 'child-a', context: 'fork' },
            { agent: 'worker', task: 'child-b', context: 'fork' },
          ],
          cwd: directory,
          agentScope: 'both',
          parentSessionFile,
          parentLeafId,
        },
        config,
      );

      const childSessionFiles = spawner.calls.map((call) => call.piArgs.sessionFile);
      expect(childSessionFiles).toHaveLength(2);
      expect(childSessionFiles[0]).toBeDefined();
      expect(childSessionFiles[1]).toBeDefined();
      expect(new Set(childSessionFiles).size).toBe(2);

      const childA = SessionManager.open(childSessionFiles[0]!, undefined, directory);
      const childB = SessionManager.open(childSessionFiles[1]!, undefined, directory);
      childA.appendMessage({ role: 'user', content: 'child-a-only', timestamp: 2 });
      childB.appendMessage({ role: 'user', content: 'child-b-only', timestamp: 3 });

      const branchText = (session: SessionManager): string =>
        session
          .getBranch()
          .map((entry) => (entry.type === 'message' ? JSON.stringify(entry.message) : ''))
          .join('\\n');
      expect(branchText(childA)).toContain('child-a-only');
      expect(branchText(childA)).not.toContain('child-b-only');
      expect(branchText(childB)).toContain('child-b-only');
      expect(branchText(childB)).not.toContain('child-a-only');
      expect(fs.readFileSync(parentSessionFile)).toEqual(parentBefore);
    });

    it('supports mixed fresh and fork tasks without forking the fresh child', async () => {
      discovery.agents.set('worker', agentConfig('worker'));
      const source = readableForkSource();

      await planner.spawn(
        baseRequest({
          tasks: [
            { agent: 'worker', task: 'fresh', context: 'fresh' },
            { agent: 'worker', task: 'fork', context: 'fork' },
          ],
          parentSessionFile: source.sessionFile,
          parentLeafId: source.leafId,
        }),
        config,
      );

      expect(spawner.calls[0]?.piArgs.sessionFile).toBeUndefined();
      expect(spawner.calls[1]?.piArgs.sessionFile).toBe('/tmp/fork-1.jsonl');
    });

    it('cleans prepared clones and starts no child when batch preparation fails', async () => {
      discovery.agents.set('worker', agentConfig('worker'));
      const source = readableForkSource();
      planner.failForkAt = 2;

      await expect(
        planner.spawn(
          baseRequest({
            tasks: [
              { agent: 'worker', task: 'a', context: 'fork' },
              { agent: 'worker', task: 'b', context: 'fork' },
            ],
            parentSessionFile: source.sessionFile,
            parentLeafId: source.leafId,
          }),
          config,
        ),
      ).rejects.toThrow(/fork preparation failed/);

      expect(planner.removedSessionFiles).toEqual(['/tmp/fork-1.jsonl']);
      expect(spawner.calls).toEqual([]);
    });

    it('continues an existing child session without cloning it again', async () => {
      discovery.agents.set('worker', agentConfig('worker', { defaultContext: 'fork' }));

      await planner.spawn(
        baseRequest({
          single: { agent: 'worker', task: 'resume', context: 'fork', sessionFile: '/tmp/child.jsonl' },
        }),
        config,
      );

      expect(planner.forkSources).toEqual([]);
      expect(spawner.calls[0]?.piArgs.sessionFile).toBe('/tmp/child.jsonl');
      expect(spawner.calls[0]?.piArgs.parentSessionId).toBeUndefined();
    });
  });

  describe('PARALLEL mode', () => {
    it('spawns every task with fanout=true and sequential childIndex', async () => {
      discovery.agents.set('a', agentConfig('a'));
      discovery.agents.set('b', agentConfig('b'));

      const result = await planner.spawn(
        baseRequest({
          tasks: [
            { agent: 'a', task: 'task-a' },
            { agent: 'b', task: 'task-b' },
          ],
        }),
        config,
      );

      expect(spawner.calls).toHaveLength(2);
      expect(spawner.calls.map((c) => c.childIndex)).toEqual([0, 1]);
      expect(spawner.calls.every((c) => c.fanout)).toBe(true);
      expect(result.outcomes.map((o) => o.agent)).toEqual(['a', 'b']);
    });

    it('keeps partial and complete skill misses independent while launching every valid child', async () => {
      skills.resolutions.set('available,missing', {
        resolved: [
          {
            name: 'available',
            description: 'Available metadata',
            path: '/skills/available/SKILL.md',
            content: 'AVAILABLE_BODY',
            source: 'project',
          },
        ],
        missing: ['missing'],
      });
      skills.resolutions.set('absent', { resolved: [], missing: ['absent'] });
      discovery.agents.set('partial', agentConfig('partial', { skills: ['available', 'missing'] }));
      discovery.agents.set('complete-miss', agentConfig('complete-miss', { skills: ['absent'] }));

      const result = await planner.spawn(
        baseRequest({
          tasks: [
            { agent: 'partial', task: 'partial task' },
            { agent: 'complete-miss', task: 'missing task' },
          ],
        }),
        config,
      );

      expect(spawner.calls).toHaveLength(2);
      expect(result.outcomes).toEqual([
        expect.objectContaining({
          agent: 'partial',
          runId: expect.any(String),
          warning: expect.stringContaining('could not resolve configured skills: missing'),
        }),
        expect.objectContaining({
          agent: 'complete-miss',
          runId: expect.any(String),
          warning: expect.stringContaining('could not resolve configured skills: absent'),
        }),
      ]);
      expect(spawner.calls.map((call) => call.piArgs.requireReadTool)).toEqual([true, false]);
      expect(spawner.calls[0]?.piArgs.systemPrompt).toContain('<name>available</name>');
      expect(spawner.calls[1]?.piArgs.systemPrompt).toBe('You are complete-miss.');
    });

    it('launches specialists in one cwd while enforcing a read-only ceiling', async () => {
      discovery.agents.set('a', agentConfig('a', { tools: ['read', 'write'] }));
      discovery.agents.set('b', agentConfig('b', { tools: ['read', 'bash'] }));
      const policies = new SubagentCapabilityPolicyStore();
      policies.register({ owner: '@agimon-ai/doompi-plan', allowedTools: ['read'] }, 'plan-generation');
      planner = new TestableSpawnPlanner(discovery, spawner, policies);

      await planner.spawn(
        baseRequest({
          tasks: [
            { agent: 'a', task: 'task-a' },
            { agent: 'b', task: 'task-b' },
          ],
        }),
        config,
      );

      expect(spawner.calls).toHaveLength(2);
      expect(spawner.calls.map((call) => call.piArgs.capabilityCeiling?.allowedTools)).toEqual([['read'], ['read']]);
    });

    it('one child failing does not prevent its siblings from spawning or being reported', async () => {
      discovery.agents.set('a', agentConfig('a'));
      discovery.agents.set('b', agentConfig('b'));
      discovery.agents.set('c', agentConfig('c'));
      spawner.results.set('b', new Error('b failed'));

      const result = await planner.spawn(
        baseRequest({
          tasks: [
            { agent: 'a', task: 'task-a' },
            { agent: 'b', task: 'task-b' },
            { agent: 'c', task: 'task-c' },
          ],
        }),
        config,
      );

      expect(spawner.calls).toHaveLength(3);
      expect(result.outcomes[0]).toMatchObject({ agent: 'a', runId: expect.any(String) });
      expect(result.outcomes[1]).toMatchObject({ agent: 'b', error: 'b failed' });
      expect(result.outcomes[2]).toMatchObject({ agent: 'c', runId: expect.any(String) });
    });

    it('an unknown agent anywhere in the batch refuses the WHOLE batch before any spawn call', async () => {
      discovery.agents.set('a', agentConfig('a'));
      // 'ghost' is never registered.

      await expect(
        planner.spawn(
          baseRequest({
            tasks: [
              { agent: 'a', task: 'task-a' },
              { agent: 'ghost', task: 'task-b' },
            ],
          }),
          config,
        ),
      ).rejects.toThrow(/'ghost'/);
      expect(spawner.calls).toHaveLength(0);
    });

    it('defaults concurrency to 4 when neither the request nor config specifies one', async () => {
      for (const name of ['a', 'b', 'c', 'd', 'e']) discovery.agents.set(name, agentConfig(name));
      let maxActive = 0;
      let active = 0;
      spawner.spawn = async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return { runId: input.runId, pid: 1 };
      };

      await planner.spawn(
        baseRequest({ tasks: ['a', 'b', 'c', 'd', 'e'].map((agent) => ({ agent, task: 'x' })) }),
        config,
      );

      expect(maxActive).toBeLessThanOrEqual(4);
    });

    it('an explicit request-level concurrency overrides the default', async () => {
      for (const name of ['a', 'b', 'c']) discovery.agents.set(name, agentConfig(name));
      let maxActive = 0;
      let active = 0;
      spawner.spawn = async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return { runId: input.runId, pid: 1 };
      };

      await planner.spawn(
        baseRequest({ tasks: ['a', 'b', 'c'].map((agent) => ({ agent, task: 'x' })), concurrency: 1 }),
        config,
      );

      expect(maxActive).toBe(1);
    });

    it('config.parallel.concurrency is honored when the request specifies none', async () => {
      for (const name of ['a', 'b', 'c']) discovery.agents.set(name, agentConfig(name));
      let maxActive = 0;
      let active = 0;
      spawner.spawn = async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return { runId: input.runId, pid: 1 };
      };

      await planner.spawn(baseRequest({ tasks: ['a', 'b', 'c'].map((agent) => ({ agent, task: 'x' })) }), {
        parallel: { concurrency: 1 },
      });

      expect(maxActive).toBe(1);
    });
  });

  describe('depth preflight', () => {
    it('refuses to spawn, before calling the spawner, when the current depth is past the configured limit', async () => {
      discovery.agents.set('worker', agentConfig('worker'));

      await expect(
        planner.spawn(baseRequest({ single: { agent: 'worker', task: 'x' }, currentDepth: 5 }), {
          maxSubagentDepth: 3,
        }),
      ).rejects.toThrow(/depth 5/);
      expect(spawner.calls).toHaveLength(0);
    });

    it('allows a spawn exactly at the configured depth limit', async () => {
      discovery.agents.set('worker', agentConfig('worker'));

      await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'x' }, currentDepth: 3 }), {
        maxSubagentDepth: 3,
      });

      expect(spawner.calls).toHaveLength(1);
    });

    it('allows a spawn with no configured depth limit regardless of currentDepth', async () => {
      discovery.agents.set('worker', agentConfig('worker'));

      await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'x' }, currentDepth: 999 }), {});

      expect(spawner.calls).toHaveLength(1);
    });
  });
});

describe('fan-out width is bounded, because concurrency cannot bound it', () => {
  let discovery: FakeAgentDiscovery;
  let spawner: FakeSpawner;
  let planner: TestableSpawnPlanner;

  beforeEach(() => {
    discovery = new FakeAgentDiscovery();
    spawner = new FakeSpawner();
    planner = new TestableSpawnPlanner(discovery, spawner);
    discovery.agents.set('worker', agentConfig('worker'));
  });

  function tasks(count: number) {
    return Array.from({ length: count }, (_, index) => ({ agent: 'worker', task: `task ${index}` }));
  }

  it('refuses a PARALLEL call wider than maxTasks before spawning anything', async () => {
    await expect(planner.spawn(baseRequest({ tasks: tasks(9) }), {})).rejects.toThrow(
      /requested 9 tasks, but at most 8 may be declared in one call/,
    );
    // Preflight means NOTHING started - not a partial fan-out that then throws.
    expect(spawner.calls).toHaveLength(0);
  });

  it('allows a call exactly at the cap', async () => {
    const result = await planner.spawn(baseRequest({ tasks: tasks(8) }), {});
    expect(result.outcomes).toHaveLength(8);
  });

  it('honours a configured maxTasks over the default', async () => {
    await expect(planner.spawn(baseRequest({ tasks: tasks(3) }), { parallel: { maxTasks: 2 } })).rejects.toThrow(
      /requested 3 tasks, but at most 2 may be declared in one call/,
    );
  });

  it('says why concurrency is not the knob to reach for, since that is the natural next guess', async () => {
    await expect(planner.spawn(baseRequest({ tasks: tasks(9) }), {})).rejects.toThrow(
      /throttles how fast they start, not how many run/,
    );
  });

  it('no longer tells the caller to split the batch across calls, which used to defeat the cap', async () => {
    const refusal = await planner.spawn(baseRequest({ tasks: tasks(9) }), {}).catch((error: unknown) => String(error));
    expect(refusal).not.toMatch(/smaller explicit run calls/);
    expect(refusal).toMatch(/does not raise the live-child ceiling/);
  });
});

describe('global admission control', () => {
  /** Children stay alive until the gate's wait frees one, standing in for detached processes. */
  class LiveChildren {
    private live = new Set<string>();
    maxObserved = 0;

    start(runId: string): void {
      this.live.add(runId);
      this.maxObserved = Math.max(this.maxObserved, this.live.size);
    }

    exitOldest(): void {
      const oldest = this.live.values().next();
      if (!oldest.done) this.live.delete(oldest.value);
    }

    count(): number {
      return this.live.size;
    }
  }

  class LiveTrackingSpawner extends FakeSpawner {
    constructor(private readonly children: LiveChildren) {
      super();
    }

    override async spawn(input: AsyncSubagentSpawnInput): Promise<AsyncSubagentSpawnResult> {
      const result = await super.spawn(input);
      // A real child registers in `runRegistry` before `spawn` resolves and
      // then keeps running detached.
      this.children.start(result.runId);
      return result;
    }
  }

  function tasks(count: number, label: string) {
    return Array.from({ length: count }, (_, index) => ({ agent: 'worker', task: `${label} ${index}` }));
  }

  it('holds concurrent PARALLEL calls to one process-wide ceiling, not one ceiling per call', async () => {
    const children = new LiveChildren();
    const discovery = new FakeAgentDiscovery();
    discovery.agents.set('worker', agentConfig('worker'));
    const spawner = new LiveTrackingSpawner(children);
    const gate = new AdmissionGate({
      countLiveRuns: () => children.count(),
      // Each wait retires one child, so a saturated queue drains deterministically.
      wait: async () => children.exitOldest(),
    });
    const planner = new TestableSpawnPlanner(discovery, spawner, undefined, undefined, undefined, undefined, gate);
    const config: ExtensionConfig = { parallel: { maxTasks: 4, concurrency: 4, maxLiveRuns: 3 } };

    const results = await Promise.all([
      planner.spawn(baseRequest({ tasks: tasks(4, 'a') }), config),
      planner.spawn(baseRequest({ tasks: tasks(4, 'b') }), config),
      planner.spawn(baseRequest({ tasks: tasks(4, 'c') }), config),
    ]);

    // Twelve children were requested across three calls that each pass the
    // per-call `maxTasks` check; only three may be alive at once.
    expect(children.maxObserved).toBeLessThanOrEqual(3);
    const outcomes = results.flatMap((result) => result.outcomes);
    expect(outcomes).toHaveLength(12);
    expect(outcomes.filter((outcome) => outcome.error)).toEqual([]);
  });

  it('refuses a child as a per-child error when no slot frees before the timeout', async () => {
    const discovery = new FakeAgentDiscovery();
    discovery.agents.set('worker', agentConfig('worker'));
    const spawner = new FakeSpawner();
    const events: string[] = [];
    const gate = new AdmissionGate({ countLiveRuns: () => 2, wait: async () => {}, now: () => 0 });
    const planner = new TestableSpawnPlanner(
      discovery,
      spawner,
      undefined,
      undefined,
      (event) => events.push(event),
      undefined,
      gate,
    );

    const result = await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'work' } }), {
      parallel: { maxLiveRuns: 2, admissionTimeoutMs: 0 },
    });

    expect(result.outcomes[0]?.error).toMatch(/No child slot became available/);
    expect(spawner.calls).toHaveLength(0);
    expect(events).toContain('doom_team.admission_wait');
  });
});

describe('persisted session forks', () => {
  it('excludes the active assistant tool-call turn and leaves the parent file unchanged', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-real-fork-'));
    temporaryDirectories.push(directory);
    const parent = SessionManager.create(directory, directory);
    const userId = parent.appendMessage({ role: 'user', content: 'unique-parent-marker', timestamp: 1 });
    const assistantId = parent.appendMessage({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'subagent', arguments: {} }],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: 2,
    });
    const parentSessionFile = parent.getSessionFile()!;
    const before = fs.readFileSync(parentSessionFile);

    expect(captureSessionForkSource(parent, 'tool')).toEqual({ sessionFile: parentSessionFile, leafId: userId });
    expect(captureSessionForkSource(parent, 'settled')).toEqual({
      sessionFile: parentSessionFile,
      leafId: assistantId,
    });

    const discovery = new FakeAgentDiscovery();
    discovery.agents.set('worker', agentConfig('worker'));
    const spawner = new FakeSpawner();
    const planner = new SpawnPlanner(discovery, spawner);
    await planner.spawn(
      {
        single: { agent: 'worker', task: 'inherit marker', context: 'fork' },
        cwd: directory,
        agentScope: 'both',
        parentSessionFile,
        parentLeafId: userId,
      },
      {},
    );

    const childSessionFile = spawner.calls[0]?.piArgs.sessionFile;
    expect(childSessionFile).toBeDefined();
    expect(childSessionFile).not.toBe(parentSessionFile);
    expect(fs.readFileSync(parentSessionFile)).toEqual(before);

    const child = SessionManager.open(childSessionFile!, undefined, directory);
    expect(child.getBranch().map((entry) => entry.id)).toContain(userId);
    expect(child.getBranch().map((entry) => entry.id)).not.toContain(assistantId);
  });
});

describe('timeoutMs is not the spawn handshake timeout', () => {
  let discovery: FakeAgentDiscovery;
  let spawner: FakeSpawner;
  let planner: TestableSpawnPlanner;

  beforeEach(() => {
    discovery = new FakeAgentDiscovery();
    spawner = new FakeSpawner();
    planner = new TestableSpawnPlanner(discovery, spawner);
    discovery.agents.set('worker', agentConfig('worker'));
  });

  it('never forwards a caller timeout as handshakeTimeoutMs', async () => {
    // The bug this pins: `timeoutMs` used to become the handshake bound, so
    // `timeoutMs: 1800000` turned a child that failed to boot into a 30-minute
    // hang, while capping nothing about the run itself.
    await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'x' } }), {});

    expect(spawner.calls[0]?.handshakeTimeoutMs).toBeUndefined();
  });

  it('takes the handshake bound from config instead', async () => {
    await planner.spawn(baseRequest({ single: { agent: 'worker', task: 'x' } }), { handshakeTimeoutMs: 5_000 });

    expect(spawner.calls[0]?.handshakeTimeoutMs).toBe(5_000);
  });
});
