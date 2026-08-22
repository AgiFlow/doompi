import fs from 'node:fs';
import path from 'node:path';
import { resolvePluginEntries, resolveSharedSkills } from '@agimon-ai/doompi-config/domains';
import { requireHarnessPaths, updateHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import type { DoomHarnessContext, HarnessState } from '@agimon-ai/doompi-config/types';
import { resolveMcpAllowlist } from './mcpFilter.ts';
import { materializePluginEntries } from './pluginMaterializer.ts';
import { collectResources } from './resourceCollector.ts';

/**
 * Live domain switching: skills, plugin hooks, MCP config and subagent directories.
 *
 * Writes through the harness state module and relies on Pi's reload
 * re-executing extension modules. The replacement Config factory publishes the
 * persisted MCP projection on the new session's Cordis root.
 *
 * What reload cannot do is change the SET of loaded extensions: Pi freezes the
 * CLI --extension list at construction and re-resolves that same array on every
 * reload. Callers report those parts as needing a relaunch instead of pretending
 * they applied.
 *
 * The major-mode and profile switches live in
 * @agimon-ai/doompi-config/selectionSwitch: they are config writes with no
 * resource staging, and the synced startup path applies them before any command
 * exists to run. Domains stays here because it stages plugins, skills and MCP
 * config.
 */
export async function applyDomains(domainNames: string[], state: DoomHarnessContext): Promise<HarnessState> {
  const { root, temporaryDirectory } = requireHarnessPaths(state);

  const pluginEntries = await materializePluginEntries(
    resolvePluginEntries(root, domainNames, [...state.pluginDirectories]),
  );
  const mcpAllowlist = resolveMcpAllowlist(root, domainNames);
  // Keep the active generation untouched while the candidate is parsed and
  // normalized. Pi's reload later removes the whole process-owned run root, so
  // retired generations need no eager destructive cleanup here.
  const candidateDirectory = await fs.promises.mkdtemp(path.join(temporaryDirectory, 'domains-'));
  let resources: Awaited<ReturnType<typeof collectResources>>;
  try {
    resources = await collectResources(root, pluginEntries, {
      agents: state.agents,
      mcp: state.mcp,
      temporaryDirectory: candidateDirectory,
      sharedSkills: resolveSharedSkills(root, domainNames),
      mcpAllowlist,
    });
  } catch (error) {
    await fs.promises.rm(candidateDirectory, { recursive: true, force: true });
    throw error;
  }

  let updated: HarnessState;
  try {
    updated = updateHarnessState({
      domains: domainNames,
      skillDirectories: resources.skillDirectories,
      agentDirectories: resources.agentDirectories,
      pluginHooks: resources.pluginHooks,
      mcpConfigPath: resources.mcpConfigPath,
      mcpProjection: resources.mcpProjection,
    });
  } catch (error) {
    await fs.promises.rm(candidateDirectory, { recursive: true, force: true });
    throw error;
  }
  process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = resources.agentDirectories.join(path.delimiter);
  process.env.PI_SUBAGENT_EXTRA_SKILL_DIRS = resources.skillDirectories.join(path.delimiter);
  return updated;
}
