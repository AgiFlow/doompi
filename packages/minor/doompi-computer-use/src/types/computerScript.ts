import type {
  ComputerUseAction,
  ComputerUseObservation,
  ComputerUseObservationOptions,
  ComputerUseSessionClient,
} from './computerUse';

export interface ComputerScriptProgram {
  observe(options?: ComputerUseObservationOptions): Promise<ComputerUseObservation>;
  act(action: ComputerUseAction): Promise<unknown>;
}

export interface ComputerScriptLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ComputerScriptRunContext {
  context: { program: ComputerScriptProgram };
  input: unknown;
  logger: ComputerScriptLogger;
  /** Portable cancellation surface. Trusted Node scripts receive the full AbortSignal. */
  signal: Pick<AbortSignal, 'aborted' | 'throwIfAborted'>;
}

/** Both a synchronous result and a promise are accepted and awaited by the worker. */
export type ComputerScriptRun = (options: ComputerScriptRunContext) => unknown;

export interface ComputerScriptExecutionResult {
  result?: unknown;
  observation: ComputerUseObservation;
  logs: readonly string[];
  metrics?: {
    actions: number;
    observations: number;
    durationMs: number;
    outputBytes: number;
  };
}

export interface ComputerScriptExecutionOptions {
  /** Full Node execution additionally requires an exact host-configured path allowlist. */
  trusted?: boolean;
  includeScreenshot?: boolean;
}

export interface ComputerScriptExecutor {
  execute(
    scriptPath: string,
    input: unknown,
    signal?: AbortSignal,
    options?: ComputerScriptExecutionOptions,
  ): Promise<ComputerScriptExecutionResult>;
}

export interface ComputerScriptRunnerOptions {
  readonly client: ComputerUseSessionClient;
  readonly allowedScriptPaths: readonly string[];
  /** Host-admitted root for generated functions and their relative helper modules. */
  readonly scriptRoot?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}
