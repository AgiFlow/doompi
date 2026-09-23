import os from 'node:os';

import { loadDomains } from '@agimon-ai/doompi-config/domains';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import type { HarnessTelemetry } from '@agimon-ai/doompi-core/runtimeLogSinkTelemetry';

import { buildPreparedRuntime, type BuildResult } from '../../../builders/cli/prepare';
import { DUPLICATE_REGISTRATION_DRIFT } from '../../../builders/cli/projectSettings';
import { parseHarnessArgs } from '../../options';
import { environmentForSyncScope, resolveSyncRoots, selectionEnvironment } from './index';
export type { BuildResult } from '../../../builders/cli/prepare';
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
  const roots = resolveSyncRoots(args, environment, currentDirectory, homeDirectory);
  const repoRoot = roots.targetRoot;
  const scopedEnvironment = environmentForSyncScope(environment, roots.globalOnly);
  const parsed = parseHarnessArgs(
    args.slice(1).filter((argument) => argument !== '--global'),
    selectionEnvironment(repoRoot, scopedEnvironment, homeDirectory),
    roots.globalOnly ? repoRoot : currentDirectory,
    loadMajorModesConfig(repoRoot, homeDirectory).defaultMajorMode,
    loadDomains(repoRoot, homeDirectory).defaultDomains,
  );
  const result = await buildPreparedRuntime(
    { ...parsed.options, repoRoot, homeDirectory },
    scopedEnvironment,
    telemetry,
  );
  output.write(formatBuildResult(result));
  return 0;
}
