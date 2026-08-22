import {
  HARNESS_STATE_KEYS,
  projectHarnessEnvironment,
  readHarnessState as readSharedHarnessState,
} from '@agimon-ai/doompi-config/harnessState';
import {
  createHarnessSession,
  getHarnessState as getSharedHarnessState,
  HARNESS_STATE_POINTER,
  harnessRoot,
  loadHarnessState,
  requireHarnessPaths,
  requireHarnessRoot,
  resetHarnessStore,
  restoreHarnessStateSnapshot,
  snapshotHarnessState,
  updateHarnessState as updateSharedHarnessState,
} from '@agimon-ai/doompi-config/harnessStore';
import type { HarnessState } from '@agimon-ai/doompi-config/types';
import { HARNESS_EVENT, type HarnessFailureReporter } from '../../adapters/telemetry/logSinkTelemetry.ts';

export type { HarnessStateTransactionSnapshot } from '@agimon-ai/doompi-config/harnessStore';
export type { DoomHarnessContext, HarnessState } from '@agimon-ai/doompi-config/types';
export {
  createHarnessSession,
  HARNESS_STATE_KEYS,
  HARNESS_STATE_POINTER,
  harnessRoot,
  loadHarnessState,
  projectHarnessEnvironment,
  requireHarnessPaths,
  requireHarnessRoot,
  resetHarnessStore,
  restoreHarnessStateSnapshot,
  snapshotHarnessState,
};

function telemetryReporter(report?: HarnessFailureReporter): ((key: string, error: unknown) => void) | undefined {
  if (!report) return undefined;
  return (key, error) => {
    report.warn(HARNESS_EVENT.harnessStateParseFailed, error, { 'harness.state.key': key });
  };
}

export function readHarnessState(
  environment: NodeJS.ProcessEnv = process.env,
  report?: HarnessFailureReporter,
): HarnessState {
  return readSharedHarnessState(environment, telemetryReporter(report));
}

export function getHarnessState(report?: HarnessFailureReporter): HarnessState {
  return getSharedHarnessState(telemetryReporter(report));
}

/**
 * Re-reads the state, dropping what this process had cached.
 *
 * The store caches for the life of a process because nothing else writes the
 * file it owns. A test suite and a Pi reload are the two places that outlive
 * that assumption, so both come through here.
 */
export function refreshHarnessState(report?: HarnessFailureReporter): HarnessState {
  resetHarnessStore();
  return getHarnessState(report);
}

export function updateHarnessState(
  patch: Partial<HarnessState>,
  environment: NodeJS.ProcessEnv = process.env,
): HarnessState {
  return updateSharedHarnessState(patch, environment);
}
