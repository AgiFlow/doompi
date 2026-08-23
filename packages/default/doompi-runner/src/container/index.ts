import { BashRunService } from '../adapters/BashRunService/BashRunService';
import { SystemClock } from '../adapters/Clock/SystemClock';
import { Launcher } from '../adapters/Launcher/Launcher';
import { NodeLifeline } from '../adapters/Lifeline/NodeLifeline';
import { LogFile } from '../adapters/LogFile/LogFile';
import { LogReader } from '../adapters/LogReader/LogReader';
import { NodeProcessControl } from '../adapters/ProcessControl/NodeProcessControl';
import { PtyHost } from '../adapters/PtyHost/PtyHost';
import { NodePtySpawner } from '../adapters/PtySpawner/NodePtySpawner';
import { RmuxBackend } from '../adapters/RmuxBackend/RmuxBackend';
import { PtyBackendChain } from '../adapters/PtyBackendChain/PtyBackendChain';
import { TmuxBackend } from '../adapters/TmuxBackend/TmuxBackend';
import { RtkProcessor } from '../adapters/RtkProcessor/RtkProcessor';
import { RunnerNamer } from '../services/RunnerNamer/RunnerNamer';
import { RunnerPaths } from '../adapters/RunnerPaths';
import { RunnerRegistry, createDefaultProcessRegistry } from '../adapters/RunnerRegistry/RunnerRegistry';
import { NodeSpawner } from '../adapters/Spawner/NodeSpawner';
import type { RunnerDependencies } from './types';

/** Build once on first access, then hand back the same instance. */
function memoize<T>(build: () => T): () => T {
  let value: T | undefined;
  let built = false;
  return () => {
    if (!built) {
      value = build();
      built = true;
    }
    return value as T;
  };
}

/**
 * Builds the extension's service graph.
 *
 * A factory rather than a module-level singleton: the extension owns one graph
 * per session, and tests get a fresh one they can substitute ports on through
 * `overrides` without leaking state between cases.
 *
 * Every slot resolves lazily and memoizes, which keeps the previous container's
 * behaviour: nothing is constructed until it is asked for, so opening the SQLite
 * process registry stays deferred until something actually needs a runner.
 */
export function createRunnerContainer(overrides: Partial<RunnerDependencies> = {}): RunnerDependencies {
  const clock = memoize(() => overrides.clock ?? new SystemClock());
  const spawner = memoize(() => overrides.spawner ?? new NodeSpawner());
  const processControl = memoize(() => overrides.processControl ?? new NodeProcessControl());
  const ptySpawner = memoize(() => overrides.ptySpawner ?? new NodePtySpawner());
  const paths = memoize(() => overrides.paths ?? new RunnerPaths());
  const lifeline = memoize(() => overrides.lifeline ?? new NodeLifeline(paths()));
  const processRegistry = memoize(() => overrides.processRegistry ?? createDefaultProcessRegistry());
  const runnerRegistry = memoize(
    () => overrides.runnerRegistry ?? new RunnerRegistry(paths(), processControl(), processRegistry()),
  );
  const namer = memoize(() => overrides.namer ?? new RunnerNamer(runnerRegistry()));
  const logFile = memoize(() => overrides.logFile ?? new LogFile(paths()));
  const logReader = memoize(() => overrides.logReader ?? new LogReader());
  const launcher = memoize(
    () => overrides.launcher ?? new Launcher(spawner(), processControl(), logFile(), clock(), paths()),
  );
  const rmuxBackend = memoize(
    () => overrides.rmuxBackend ?? new PtyBackendChain(new RmuxBackend(paths()), new TmuxBackend(paths())),
  );
  const rtkProcessor = memoize(() => overrides.rtkProcessor ?? new RtkProcessor());
  const ptyHost = memoize(() => overrides.ptyHost ?? new PtyHost(ptySpawner(), logFile(), processControl(), clock()));
  const bashRunService = memoize(
    () =>
      overrides.bashRunService ??
      new BashRunService(launcher(), rmuxBackend(), namer(), runnerRegistry(), clock(), rtkProcessor()),
  );

  return {
    get clock() {
      return clock();
    },
    get spawner() {
      return spawner();
    },
    get processControl() {
      return processControl();
    },
    get ptySpawner() {
      return ptySpawner();
    },
    get paths() {
      return paths();
    },
    get lifeline() {
      return lifeline();
    },
    get processRegistry() {
      return processRegistry();
    },
    get runnerRegistry() {
      return runnerRegistry();
    },
    get namer() {
      return namer();
    },
    get logFile() {
      return logFile();
    },
    get logReader() {
      return logReader();
    },
    get launcher() {
      return launcher();
    },
    get rmuxBackend() {
      return rmuxBackend();
    },
    get rtkProcessor() {
      return rtkProcessor();
    },
    get ptyHost() {
      return ptyHost();
    },
    get bashRunService() {
      return bashRunService();
    },
  };
}
