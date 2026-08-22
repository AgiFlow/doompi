import type { IBashRunService } from '../types/bashRunService';
import type { IClock } from '../types/clock';
import type { ILauncher } from '../types/launcher';
import type { ILifeline } from '../types/lifeline';
import type { ILogFile } from '../types/logFile';
import type { ILogReader } from '../types/logReader';
import type { IProcessControl } from '../types/processControl';
import type { IPtyHost } from '../types/ptyHost';
import type { IPtySpawner } from '../types/ptySpawner';
import type { IRmuxBackend } from '../types/rmuxBackend';
import type { IRtkProcessor } from '../types/rtkProcessor';
import type { IRunnerNamer } from '../services/RunnerNamer/types';
import type { IRunnerPaths } from '../services/RunnerPaths/types';
import type { ProcessRegistryPort } from '../adapters/RunnerRegistry/RunnerRegistry';
import type { IRunnerRegistry } from '../types/runnerRegistry';
import type { ISpawner } from '../types/spawner';

/** Everything the runner runtime is assembled from. */
export interface RunnerDependencies {
  readonly clock: IClock;
  readonly spawner: ISpawner;
  readonly processControl: IProcessControl;
  readonly ptySpawner: IPtySpawner;
  readonly paths: IRunnerPaths;
  readonly lifeline: ILifeline;
  readonly runnerRegistry: IRunnerRegistry;
  readonly namer: IRunnerNamer;
  readonly logFile: ILogFile;
  readonly logReader: ILogReader;
  readonly launcher: ILauncher;
  readonly rmuxBackend: IRmuxBackend;
  readonly rtkProcessor: IRtkProcessor;
  readonly ptyHost: IPtyHost;
  readonly bashRunService: IBashRunService;
  /** Opened on first access; creating it touches SQLite. */
  readonly processRegistry: ProcessRegistryPort;
}
