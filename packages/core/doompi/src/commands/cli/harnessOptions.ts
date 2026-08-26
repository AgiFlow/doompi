import path from 'node:path';
import { loadDomains } from '@agimon-ai/doompi-config/domains';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { parseHarnessArgs } from './options.ts';
import { readHarnessState } from '../../adapters/config/harnessState.ts';
import { findRepositoryRoot } from '../../adapters/repository/repository.ts';
import type { HarnessFailureReporter } from '../../adapters/telemetry/logSinkTelemetry.ts';
import type { HarnessOptions } from '../../types/interfaces/harness';

export interface ResolveHarnessOptionsInput {
  /** Raw launcher arguments, as the binary received them. */
  args: readonly string[];
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Reports a malformed inherited harness state without failing the run. */
  report?: HarnessFailureReporter;
}

/**
 * Settles the repository root and the full option matrix for one run.
 *
 * Two passes are required: the first reads --cwd without touching repository
 * configuration, which keeps a run resolvable even when modes.yaml is
 * malformed, and the second applies the defaults that root supplies. An
 * inherited root wins, which is how a nested run stays pinned to the outer
 * repository rather than re-deriving one from its own cwd.
 */
export function resolveHarnessOptions(input: ResolveHarnessOptionsInput): HarnessOptions {
  const environment = input.environment ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const args = [...input.args];

  const initial = parseHarnessArgs(args);
  const inheritedRoot = readHarnessState(environment, input.report).root;
  const repoRoot = inheritedRoot ? path.resolve(inheritedRoot) : findRepositoryRoot(initial.options.cwd);
  const parsed = parseHarnessArgs(
    args,
    environment,
    cwd,
    loadMajorModesConfig(repoRoot).defaultMajorMode,
    loadDomains(repoRoot).defaultDomains,
  );
  return { repoRoot, ...parsed.options };
}
