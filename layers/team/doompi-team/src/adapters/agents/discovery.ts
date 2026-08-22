/**
 * Cached discovery of the agents visible from a working directory.
 *
 * WHY THIS IS A SERVICE AND NOT A FUNCTION:
 * Discovery reads two settings files and walks every agent directory in scope,
 * parsing the frontmatter of every file it finds. The slash-command completion
 * path asks for the agent list on each keystroke, and preflight asks again for
 * each launch, so the predecessor's plain function re-walked the tree many times
 * per second. Caching needs somewhere to live, and invalidation needs an owner.
 *
 * DESIGN PATTERNS:
 * - Two-layer validity. A short TTL bounds how stale an answer can be, and a
 *   cheap source fingerprint catches the common edits sooner than the TTL would
 * - Bounded by an LRU keyed on cwd and scope, so a long session that visits many
 *   directories cannot grow the cache without limit
 * - Mutations invalidate explicitly rather than relying on the TTL, so an agent
 *   the user just created is visible immediately
 *
 * WHY THE FINGERPRINT IS NOT ENOUGH ON ITS OWN:
 * It stats the settings files and the agent directories, not every agent file.
 * A directory's mtime moves when a file is added or removed but not when an
 * existing file's contents change, so an in-place edit is caught by the TTL
 * rather than by the fingerprint. Stat'ing every agent file on every keystroke
 * would reintroduce the cost this cache exists to remove.
 *
 * AVOID:
 * - Handing out the cached array without copying it; a caller that sorts or
 *   splices in place would corrupt every later reader
 * - Raising the TTL to hide a missing invalidate call
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHarnessState, loadMajorModesConfig, resolvePackageConfigurations } from '@agimon-ai/doompi-config';

import {
  DOOMPI_TEAM_PACKAGE,
  mergeTeamPackageConfigurations,
  type TeamPackageConfig,
} from '../../schemas/team/packageConfig';
import { LruCache } from '../../services/support/lruCache';
import { loadAgentsFromDir, pluginAgentDirs } from './loader';
import {
  canonicalizeDiscoveryCwd,
  getProjectAgentSettingsPath,
  getUserAgentSettingsPath,
  resolveNearestProjectAgentDirs,
  userAgentDirs,
} from './projectRoot';
import {
  applyCustomAgentOverrides,
  applySubagentDefaults,
  EMPTY_SUBAGENT_SETTINGS,
  readSubagentSettings,
  resolveSubagentDefaultExtensions,
  resolveSubagentDefaultModel,
  resolveSubagentDefaultThinking,
} from './settings';
import type { AgentConfig, AgentDiscoveryResult, AgentScope, AgentDiscoveryContract, SubagentSettings } from './types';

/** How long a discovery result may be reused without revalidation. */
const DISCOVERY_TTL_MS = 5_000;

/**
 * How many (cwd, scope) combinations stay cached.
 *
 * A session works in a handful of directories and there are three scopes, so
 * this is far above real usage; it exists to bound a pathological case.
 */
const MAX_CACHED_DISCOVERIES = 64;

const FINGERPRINT_FIELD_SEPARATOR = ':';
const FINGERPRINT_ENTRY_SEPARATOR = '|';
const MISSING_SOURCE_MARKER = '-';
const MAJOR_MODES_CONFIG_RELATIVE_PATH = path.join('.doom', 'modes.yaml');
const THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max)$/;

interface CacheEntry {
  result: AgentDiscoveryResult;
  expiresAt: number;
  fingerprint: string;
}

/**
 * Merge the sources into one list, later sources shadowing earlier ones.
 *
 * Precedence is plugin, then user, then project: the definition closest to the
 * work being done wins, which is what lets a repository pin an agent that the
 * user has also defined globally.
 */
export function mergeAgentsForScope(
  scope: AgentScope,
  userAgents: AgentConfig[],
  projectAgents: AgentConfig[],
  pluginAgents: AgentConfig[] = [],
): AgentConfig[] {
  const byName = new Map<string, AgentConfig>();
  for (const agent of pluginAgents) byName.set(agent.name, agent);
  if (scope !== 'project') {
    for (const agent of userAgents) byName.set(agent.name, agent);
  }
  if (scope !== 'user') {
    for (const agent of projectAgents) byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

/** Size and mtime of one path, or a marker when it does not exist. */
function stampOf(target: string): string {
  try {
    const stat = fs.statSync(target);
    return `${target}${FINGERPRINT_FIELD_SEPARATOR}${stat.mtimeMs}${FINGERPRINT_FIELD_SEPARATOR}${stat.size}`;
  } catch {
    // A missing settings file or agent directory is a normal state, and it has
    // to be distinguishable from a present one so that creating it invalidates.
    return `${target}${FINGERPRINT_FIELD_SEPARATOR}${MISSING_SOURCE_MARKER}`;
  }
}

export interface ActiveTeamPackageConfig {
  config: TeamPackageConfig;
  path: string;
}

/** Resolve Team-owned package configuration from the current parent harness state. */
export function resolveActiveTeamPackageConfig(): ActiveTeamPackageConfig | undefined {
  const harness = getHarnessState();
  if (!harness.root) return undefined;
  const layers = loadMajorModesConfig(harness.root);
  const entries = resolvePackageConfigurations(layers, harness.layers, DOOMPI_TEAM_PACKAGE);
  const config = mergeTeamPackageConfigurations(entries);
  return config ? { config, path: path.join(harness.root, MAJOR_MODES_CONFIG_RELATIVE_PATH) } : undefined;
}

function teamModelSpecs(config: TeamPackageConfig | undefined): string[] | undefined {
  if (!config?.models) return undefined;
  return config.models.map(({ model, thinking }) =>
    thinking ? `${model.replace(THINKING_SUFFIX, '')}:${thinking}` : model,
  );
}

/** Resolve Team's ordered package model policy without merging it into an agent definition. */
export function resolveActiveTeamModelSpecs(): string[] | undefined {
  return teamModelSpecs(resolveActiveTeamPackageConfig()?.config);
}

export class AgentDiscoveryService implements AgentDiscoveryContract {
  private readonly cache = new LruCache<string, CacheEntry>(MAX_CACHED_DISCOVERIES);

  /**
   * Seams for tests, as protected members rather than constructor arguments.
   *
   * Runtime tuning is not part of this service's dependency contract. A test
   * subclass overrides these values without abstracting the clock.
   */
  protected readonly ttlMs: number = DISCOVERY_TTL_MS;

  protected now(): number {
    return Date.now();
  }

  discover(cwd: string, scope: AgentScope): AgentDiscoveryResult {
    const resolvedCwd = path.resolve(cwd);
    const canonicalCwd = canonicalizeDiscoveryCwd(resolvedCwd);
    const key = `${scope}${FINGERPRINT_ENTRY_SEPARATOR}${canonicalCwd}`;
    const cached = this.cache.get(key);
    const timestamp = this.now();

    if (cached && cached.expiresAt > timestamp && cached.fingerprint === this.fingerprint(canonicalCwd)) {
      return cloneResult(cached.result);
    }

    const result = this.load(resolvedCwd, scope);
    this.cache.set(key, {
      result,
      expiresAt: timestamp + this.ttlMs,
      fingerprint: this.fingerprint(canonicalCwd),
    });
    return cloneResult(result);
  }

  find(cwd: string, scope: AgentScope, name: string): AgentConfig | undefined {
    return this.discover(cwd, scope).agents.find((agent) => agent.name === name);
  }

  invalidate(): void {
    this.cache.clear();
  }

  /**
   * A cheap stamp of everything discovery reads at the directory level.
   *
   * Deliberately independent of scope: a user-scoped and a project-scoped lookup
   * from the same directory read overlapping sources, and computing one stamp
   * keeps the stat count fixed regardless of how many scopes are queried.
   */
  private fingerprint(cwd: string): string {
    const harness = getHarnessState();
    const sources = [
      getUserAgentSettingsPath(),
      getProjectAgentSettingsPath(cwd) ?? MISSING_SOURCE_MARKER,
      ...userAgentDirs(),
      ...resolveNearestProjectAgentDirs(cwd).readDirs,
      ...pluginAgentDirs(),
    ];
    if (harness.root) sources.push(path.join(harness.root, MAJOR_MODES_CONFIG_RELATIVE_PATH));
    return [...sources.map(stampOf), `active-layers${FINGERPRINT_FIELD_SEPARATOR}${harness.layers.join(',')}`].join(
      FINGERPRINT_ENTRY_SEPARATOR,
    );
  }

  /**
   * The uncached read. Protected so a test can count how often it actually runs,
   * which is the only direct way to assert that the cache is doing its job.
   */
  protected load(cwd: string, scope: AgentScope): AgentDiscoveryResult {
    const userSettingsPath = getUserAgentSettingsPath();
    const projectSettingsPath = getProjectAgentSettingsPath(cwd);
    const userSettings: SubagentSettings =
      scope === 'project' ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(userSettingsPath);
    const projectSettings: SubagentSettings =
      scope === 'user' ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(projectSettingsPath);

    const legacyDefaultModel = resolveSubagentDefaultModel(
      userSettings,
      projectSettings,
      userSettingsPath,
      projectSettingsPath,
    );
    const teamPackage = resolveActiveTeamPackageConfig();
    const packageModels = teamModelSpecs(teamPackage?.config);
    const packagePrimaryModel = packageModels?.[0];
    const defaultModel =
      packagePrimaryModel && teamPackage
        ? {
            type: 'packages.team.defaultModel' as const,
            scope: 'package' as const,
            path: teamPackage.path,
            model: packagePrimaryModel,
          }
        : legacyDefaultModel;
    const defaultThinking = resolveSubagentDefaultThinking(userSettings, projectSettings, projectSettingsPath);
    const defaultExtensions = resolveSubagentDefaultExtensions(userSettings, projectSettings, projectSettingsPath);

    const resolve = (agents: AgentConfig[]): AgentConfig[] =>
      applyCustomAgentOverrides(
        applySubagentDefaults(agents, defaultModel, defaultThinking, defaultExtensions),
        userSettings,
        projectSettings,
        userSettingsPath,
        projectSettingsPath,
      );

    const plugin = resolve(pluginAgentDirs().flatMap((directory) => loadAgentsFromDir(directory, 'plugin')));
    const user =
      scope === 'project' ? [] : resolve(userAgentDirs().flatMap((directory) => loadAgentsFromDir(directory, 'user')));
    const project =
      scope === 'user'
        ? []
        : resolve(
            resolveNearestProjectAgentDirs(cwd).readDirs.flatMap((directory) =>
              loadAgentsFromDir(directory, 'project'),
            ),
          );

    return {
      // A disabled agent is dropped last, so that an override which re-enables
      // one has already been applied by the time this runs.
      agents: mergeAgentsForScope(scope, user, project, plugin).filter((agent) => agent.disabled !== true),
      projectAgentsDir: resolveNearestProjectAgentDirs(cwd).preferredDir,
      modelScope: projectSettings.modelScope ?? userSettings.modelScope,
    };
  }
}

/**
 * Copy the parts a caller could mutate in place.
 *
 * The agent objects themselves are treated as immutable by every consumer, so
 * only the array is copied; deep-cloning every config on each keystroke would
 * cost more than the walk this cache replaced.
 */
function cloneResult(result: AgentDiscoveryResult): AgentDiscoveryResult {
  return { ...result, agents: [...result.agents] };
}
