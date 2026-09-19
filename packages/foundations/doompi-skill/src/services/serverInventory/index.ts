import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  listDomainNames,
  resolvePluginEntries,
  resolveSharedSkills,
  type PluginEntry,
} from '@agimon-ai/doompi-config/domains';
import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import { materializePluginEntries } from '@agimon-ai/doompi-domain/plugins';
import { collectResources, discoverSkillsAsync } from '@agimon-ai/doompi-domain/resources';
import { formatSkillsForPrompt, type Skill } from '@earendil-works/pi-coding-agent';

import { DeferredSkillLoader, type DeferredSkillSnapshot } from '../deferredSkills';

/** Skills and the domain whose selection activates them, or always-on when absent. */
export interface ServerSkillGroup {
  readonly domain?: string;
  readonly skills: readonly Skill[];
}

export interface ServerSkillInventory {
  /** Every skill any selection can reach, so an activated command can still expand. */
  readonly inventory: DeferredSkillSnapshot;
  readonly groups: readonly ServerSkillGroup[];
  readonly mcpGroups: readonly ServerSkillGroup[];
  readonly catalog: string;
}

interface SkillSource {
  readonly domain?: string;
  readonly paths: readonly string[];
  readonly mcpPaths: readonly string[];
}

const LOCAL_ONLY_MCP_PACKAGES = new Set([
  '@agimon-ai/doompi-voice',
  '@agimon-ai/doompi-git',
  '@agimon-ai/doompi-workflow',
  '@agimon-ai/doompi-user-feedback',
  '@agimon-ai/doompi-loop',
  '@agimon-ai/doompi-goal',
]);

async function isMcpSkillPlugin(entry: PluginEntry): Promise<boolean> {
  if (entry.source?.type === 'npm') return !LOCAL_ONLY_MCP_PACKAGES.has(entry.source.package);
  try {
    const manifest = JSON.parse(await readFile(path.join(entry.directory, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    return typeof manifest.name !== 'string' || !LOCAL_ONLY_MCP_PACKAGES.has(manifest.name);
  } catch {
    return true;
  }
}

/**
 * Whether a discovered skill came from one of these paths.
 *
 * A source holds exact SKILL.md files for plugin and shared skills, but a bare
 * directory for `.doom/skills`, so membership is containment rather than
 * equality.
 */
function within(filePath: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
}
/**
 * Every skill the session could reach, grouped by what activates it.
 *
 * A cockpit `/domains` switch reconciles contributions rather than rebuilding
 * the facet: the session declaration is mounted once. So enumerating only the
 * launch selection would freeze the command list at whatever was selected when
 * the session host was built. Enumerating every domain up front and tagging
 * each group with its `when` lets the existing kernel refresh do the work, the
 * same way domainServerResources registers per-domain skill resources.
 */
export async function discoverServerSkills(
  execution: DoomHeadlessExecutionContext,
  signal: AbortSignal,
): Promise<ServerSkillInventory> {
  signal.throwIfAborted();
  const state = readHarnessState(execution.environment);
  const home = execution.environment.HOME ?? os.homedir();
  const repoSkills = path.join(execution.repoRoot, '.doom', 'skills');
  const sources: SkillSource[] = [];
  const diagnostics: string[] = [];
  // A malformed domain is a configuration error in one domain, so it must not
  // remove every other domain's skills. Enumerating the whole manifest is new
  // exposure here: reading the launch selection could not fail this way.
  const domains: string[] = [];
  try {
    domains.push(...listDomainNames(execution.repoRoot, home));
  } catch (error) {
    diagnostics.push(`Domain skills are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Domain-scoped plugin skills come first. The host keeps the first command
  // registered for a name, so this ordering reproduces the collector's rule
  // that a selected plugin outranks a shared fallback of the same name.
  for (const domain of domains) {
    signal.throwIfAborted();
    try {
      const plugins = await materializePluginEntries(resolvePluginEntries(execution.repoRoot, [domain], [], home));
      const mcpPluginRoots = (
        await Promise.all(
          plugins.map(async (plugin) =>
            (await isMcpSkillPlugin(plugin)) ? path.join(plugin.directory, 'skills') : undefined,
          ),
        )
      ).filter((root): root is string => root !== undefined);
      const collected = await collectResources(execution.repoRoot, plugins, {
        agents: false,
        mcp: false,
        sharedSkills: false,
      });
      try {
        if (collected.skillDirectories.length > 0) {
          sources.push({ domain, paths: [...collected.skillDirectories], mcpPaths: mcpPluginRoots });
        }
      } finally {
        await collected.cleanup();
      }
    } catch (error) {
      diagnostics.push(`Domain '${domain}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Shared .claude/skills are not owned by any one domain, and a domain can opt
  // out of them. `when` cannot express "unless every selected domain opts out",
  // but registering a copy per domain that keeps them says the same thing: the
  // group is active if any such domain is selected, which is exactly what
  // resolveSharedSkills computes.
  signal.throwIfAborted();
  const shared = await discoverSkillsAsync(execution.repoRoot, path.join(execution.repoRoot, '.claude', 'skills'));
  if (shared.length > 0) {
    const sharedPaths = shared.map((skill) => skill.path);
    for (const domain of domains) {
      if (resolveSharedSkills(execution.repoRoot, [domain], home)) {
        sources.push({ domain, paths: sharedPaths, mcpPaths: sharedPaths });
      }
    }
  }

  // Repository-local skills belong to the repository, not to a selection.
  sources.push({ paths: [repoSkills], mcpPaths: [repoSkills] });

  signal.throwIfAborted();
  // One walk for every group. Pi drops a path it has already loaded, so the
  // loader gets the unique set and each group selects its own skills back out.
  const unique = [...new Set([...sources.flatMap((source) => source.paths), ...(state.skillDirectories ?? [])])];
  const inventory = await new DeferredSkillLoader({ cwd: execution.cwd, skillPaths: unique }).ready();
  signal.throwIfAborted();

  const groups = sources
    .map((source) => ({
      ...(source.domain === undefined ? {} : { domain: source.domain }),
      skills: inventory.skills.filter((skill) => within(skill.filePath, source.paths)),
    }))
    .filter((group) => group.skills.length > 0);
  const mcpGroups = sources
    .map((source) => ({
      ...(source.domain === undefined ? {} : { domain: source.domain }),
      skills: inventory.skills.filter((skill) => within(skill.filePath, source.mcpPaths)),
    }))
    .filter((group) => group.skills.length > 0);

  // The catalog still describes the active selection rather than everything on
  // disk, because it is prompt text rather than a menu.
  const activeSkills = inventory.skills.filter((skill) =>
    within(skill.filePath, [...(state.skillDirectories ?? []), repoSkills]),
  );
  return {
    inventory: { skills: inventory.skills, diagnostics: [...inventory.diagnostics, ...diagnostics] },
    groups,
    mcpGroups,
    catalog: formatSkillsForPrompt(activeSkills) || '(no discovered skills)',
  };
}
