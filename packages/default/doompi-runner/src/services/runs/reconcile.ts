import path from 'node:path';
import type { ILauncher } from '../../types/launcher';
import type { IProcessControl } from '../../types/processControl';
import type { IRmuxBackend } from '../../types/rmuxBackend';
import type { IRunnerPaths } from '../RunnerPaths/types';
import type { IRunnerRegistry, RunnerRecord } from '../../types/runnerRegistry';

const COMPLETED_STATE = 'completed';
const MULTIPLEXER_BACKENDS = new Set(['rmux', 'tmux']);

interface ReconcileDependencies {
  registry: IRunnerRegistry;
  launcher: ILauncher;
  rmuxBackend: IRmuxBackend;
  processControl: IProcessControl;
  currentHostPid: number;
  startup: boolean;
  active?: readonly RunnerRecord[];
}

export interface RunnerReconcileResult {
  reclaimed: string[];
  errors: string[];
}

export async function stopRunnerProcess(
  record: RunnerRecord,
  launcher: ILauncher,
  rmuxBackend: IRmuxBackend,
): Promise<boolean> {
  if (MULTIPLEXER_BACKENDS.has(record.backend) && record.backendTarget) {
    const stopped = await rmuxBackend.stop(record.backendTarget, record.pid);
    if (stopped) return true;
  }
  return launcher.stop(record.pid);
}

/** Repairs active registry entries that lost their original completion observer. */
export async function reconcileActiveRunners(dependencies: ReconcileDependencies): Promise<RunnerReconcileResult> {
  const result: RunnerReconcileResult = { reclaimed: [], errors: [] };
  const active = dependencies.active ?? (await dependencies.registry.list());
  for (const record of active) {
    try {
      const persisted = await dependencies.registry.get(record.id, record.sessionId);
      if (persisted?.state === COMPLETED_STATE) {
        await dependencies.registry.release(record.id);
        result.reclaimed.push(record.id);
        continue;
      }

      const rmuxOutcome = MULTIPLEXER_BACKENDS.has(record.backend)
        ? dependencies.rmuxBackend.readOutcome(record.id, record.sessionId)
        : undefined;
      if (rmuxOutcome) {
        await dependencies.registry.complete(
          record.id,
          {
            reason: rmuxOutcome.signal ? 'signaled' : rmuxOutcome.code === 0 ? COMPLETED_STATE : 'failed',
            code: rmuxOutcome.code,
            signal: rmuxOutcome.signal,
          },
          record.sessionId,
        );
        result.reclaimed.push(record.id);
        continue;
      }

      if (!dependencies.processControl.isAlive(record.pid)) {
        await dependencies.registry.complete(
          record.id,
          { reason: 'backend_lost', code: null, signal: null },
          record.sessionId,
        );
        result.reclaimed.push(record.id);
        continue;
      }

      const previousRuntime = dependencies.startup && record.hostPid === dependencies.currentHostPid;
      const ownerLost = !dependencies.processControl.isAlive(record.hostPid);
      if (!previousRuntime && !ownerLost) continue;

      const stopped = await stopRunnerProcess(record, dependencies.launcher, dependencies.rmuxBackend);
      if (!stopped && dependencies.processControl.isAlive(record.pid)) {
        result.errors.push(`Could not stop orphaned runner ${record.id}`);
        continue;
      }
      await dependencies.registry.complete(
        record.id,
        {
          reason: 'stopped',
          code: null,
          signal: 'SIGTERM',
          stopReason: 'owner session ended',
        },
        record.sessionId,
      );
      result.reclaimed.push(record.id);
    } catch (error) {
      result.errors.push(`Could not reconcile runner ${record.id}: ${String(error)}`);
    }
  }
  return result;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

interface LegacyCleanupDependencies extends Omit<ReconcileDependencies, 'startup'> {
  paths: IRunnerPaths;
}

/** Deletes the legacy Git store only after no live foreign runner uses it. */
export async function cleanupLegacyRunnerStore(
  dependencies: LegacyCleanupDependencies,
): Promise<RunnerReconcileResult & { removed?: string }> {
  const result: RunnerReconcileResult & { removed?: string } = { reclaimed: [], errors: [] };
  const legacyDirectory = dependencies.paths.legacyDirectory();
  if (!legacyDirectory) return result;

  const legacyRecords = (await dependencies.registry.list()).filter((record) =>
    isWithin(legacyDirectory, record.logPath),
  );
  for (const record of legacyRecords) {
    const childAlive = dependencies.processControl.isAlive(record.pid);
    const ownerAlive = dependencies.processControl.isAlive(record.hostPid);
    const ownedByPreviousRuntime = record.hostPid === dependencies.currentHostPid;
    if (childAlive && ownerAlive && !ownedByPreviousRuntime) continue;
    try {
      if (childAlive) {
        const stopped = await stopRunnerProcess(record, dependencies.launcher, dependencies.rmuxBackend);
        if (!stopped && dependencies.processControl.isAlive(record.pid)) {
          result.errors.push(`Could not stop legacy runner ${record.id}`);
          continue;
        }
      }
      await dependencies.registry.release(record.id);
      result.reclaimed.push(record.id);
    } catch (error) {
      result.errors.push(`Could not reclaim legacy runner ${record.id}: ${String(error)}`);
    }
  }

  let liveDependencies: RunnerRecord[];
  try {
    liveDependencies = (await dependencies.registry.listAcrossRepositories()).filter(
      (record) => isWithin(legacyDirectory, record.logPath) && dependencies.processControl.isAlive(record.pid),
    );
  } catch (error) {
    result.errors.push(`Could not verify legacy runner dependencies: ${String(error)}`);
    return result;
  }
  if (liveDependencies.length === 0) result.removed = dependencies.paths.removeLegacyStore();
  return result;
}
