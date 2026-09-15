import os from 'node:os';
import path from 'node:path';

import { loadDomains } from '@agimon-ai/doompi-config/domains';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import type { HarnessTelemetry } from '@agimon-ai/doompi-core/runtime-log-sink-telemetry';

import { buildPreparedRuntime, type BuildResult } from '../../../builders/cli/prepare';
import { DUPLICATE_REGISTRATION_DRIFT } from '../../../builders/cli/projectSettings';
import { resolveDoomConfigurationRoot } from '../../../composition/repository';
import { parseHarnessArgs } from '../../options';
import { selectionEnvironment } from './index';
export type { BuildResult } from '../../../builders/cli/prepare';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';
type BuildOutput = Pick<NodeJS.WritableStream, 'write'>;
export function formatBuildResult(result: BuildResult): string {
  return [
    `bundle:     ${result.bundle}`,
    `manifest:   ${result.manifest}`,
    `extensions: ${result.extensionCount} -> 1`,
    `skills:     ${result.skillCount}`,
    `agents:     ${result.agentCount}`,
    ...(result.syncedBootstrap
      ? [`bootstrap:  ${result.syncedBootstrap}`, `modes:      ${String(result.syncedBundleCount ?? 0)} precompiled`]
      : []),
    // Build never writes settings, so it reports what only sync can repair.
    ...(result.duplicateRegistration ? [`warning:    ${DUPLICATE_REGISTRATION_DRIFT}; run doompi sync`] : []),
    '',
    'Doom Pi is built. The next launch will use the dist mode extension.',
    '',
  ].join('\n');
}

export async function prepareSync(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  output: BuildOutput = process.stdout,
  telemetry?: HarnessTelemetry,
): Promise<number> {
  const homeDirectory = environment.HOME ?? os.homedir();
  const inheritedRoot = environment[HARNESS_ROOT_ENV];
  const repoRoot = inheritedRoot
    ? path.resolve(inheritedRoot)
    : resolveDoomConfigurationRoot(currentDirectory, homeDirectory);
  const parsed = parseHarnessArgs(
    args.slice(1),
    selectionEnvironment(repoRoot, environment),
    currentDirectory,
    loadMajorModesConfig(repoRoot, homeDirectory).defaultMajorMode,
    loadDomains(repoRoot, homeDirectory).defaultDomains,
  );
  const result = await buildPreparedRuntime({ ...parsed.options, repoRoot, homeDirectory }, environment, telemetry);
  output.write(formatBuildResult(result));
  return 0;
}
