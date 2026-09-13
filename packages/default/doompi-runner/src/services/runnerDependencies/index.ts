import { BashRunService } from '../bashRunService';
import { SystemClock } from '../clock';
import { Launcher } from '../launcher';
import { NodeLifeline } from '../lifeline';
import { LogFile } from '../logFile';
import { LogReader } from '../logReader';
import { NodeProcessControl } from '../processControl';
import { PtyBackendChain } from '../ptyBackendChain';
import { PtyHost } from '../ptyHost';
import { NodePtySpawner } from '../ptySpawner';
import { RmuxBackend } from '../rmuxBackend';
import { RtkProcessor } from '../rtkProcessor';
import { RunnerNamer } from '../runnerNamer';
import { RunnerPaths } from '../runnerPaths';
import { RunnerRegistry, createDefaultProcessRegistry } from '../runnerRegistry';
import { NodeSpawner } from '../spawner';
import { TmuxBackend } from '../tmuxBackend';
import type { RunnerDependencies } from './type';
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
export function createRunnerDependencies(
  overrides: Partial<RunnerDependencies> & {
    environment: Readonly<Record<string, string | undefined>>;
  },
): RunnerDependencies {
  const environment = overrides.environment;
  const clock = memoize(() => overrides.clock ?? new SystemClock());
  const spawner = memoize(() => overrides.spawner ?? new NodeSpawner());
  const processControl = memoize(() => overrides.processControl ?? new NodeProcessControl());
  const ptySpawner = memoize(() => overrides.ptySpawner ?? new NodePtySpawner());
  const paths = memoize(() => overrides.paths ?? new RunnerPaths());
  const lifeline = memoize(() => overrides.lifeline ?? new NodeLifeline(paths()));
  const processRegistry = memoize(() => overrides.processRegistry ?? createDefaultProcessRegistry());
  const runnerRegistry = memoize(
    () => overrides.runnerRegistry ?? new RunnerRegistry(paths(), processControl(), processRegistry(), environment),
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
    environment,
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
