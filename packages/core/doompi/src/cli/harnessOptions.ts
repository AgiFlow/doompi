import path from 'node:path';
import os from 'node:os';
import { loadDoomConfig } from '@agimon-ai/doompi-config/config';
import { HARNESS_STATE_KEYS } from '@agimon-ai/doompi-config/harnessState';
import { loadDomains } from '@agimon-ai/doompi-config/domains';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { loadProfileCatalog } from '@agimon-ai/doompi-config/profiles';
import { parseHarnessArgs } from './options';
import { readHarnessState } from '../composition/harnessState';
import { findRepositoryRoot } from '../composition/repository';
import type { HarnessFailureReporter } from '@agimon-ai/doompi-core/runtime-log-sink-telemetry';
import type { HarnessOptions } from '../composition/types/harness';

export interface ResolveHarnessOptionsInput {
  /** Raw launcher arguments, as the binary received them. */
  args: readonly string[];
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Reports a malformed inherited harness state without failing the run. */
  report?: HarnessFailureReporter;
}

/** Uses the nearest configured repository, or the selected directory for an unconfigured workspace. */
function resolveConfigurationRoot(cwd: string): string {
  try {
    return findRepositoryRoot(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * Settles the configuration root and the full option matrix for one run.
 *
 * Two passes are required: the first reads --cwd without touching repository
 * configuration, which keeps a run resolvable even when modes.yaml is
 * malformed, and the second applies the defaults that root supplies. An
 * inherited root wins, which is how a nested run stays pinned to the outer
 * repository rather than re-deriving one from its own cwd. When no configured
 * repository exists, the selected working directory is the configuration root.
 */
export function resolveHarnessOptions(input: ResolveHarnessOptionsInput): HarnessOptions {
  const environment = input.environment ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const args = [...input.args];

  const initial = parseHarnessArgs(args, environment, cwd);
  const inheritedRoot = readHarnessState(environment, input.report).root;
  const repoRoot = inheritedRoot ? path.resolve(inheritedRoot) : resolveConfigurationRoot(initial.options.cwd);
  const homeDirectory = initial.options.homeDirectory ?? environment.HOME ?? os.homedir();
  const defaults = loadDoomConfig(repoRoot, homeDirectory).selection;
  const selectedEnvironment = { ...environment };
  for (const axis of ['majorMode', 'domains', 'profile'] as const) {
    const value = defaults?.[axis];
    if (value !== undefined && selectedEnvironment[HARNESS_STATE_KEYS[axis]] === undefined)
      selectedEnvironment[HARNESS_STATE_KEYS[axis]] = Array.isArray(value) ? value.join(',') : value;
  }
  const parsed = parseHarnessArgs(
    args,
    selectedEnvironment,
    cwd,
    loadMajorModesConfig(repoRoot, homeDirectory).defaultMajorMode,
    loadDomains(repoRoot, homeDirectory).defaultDomains,
    loadProfileCatalog(repoRoot, homeDirectory).defaultProfile,
  );
  return { repoRoot, ...parsed.options, homeDirectory };
}
