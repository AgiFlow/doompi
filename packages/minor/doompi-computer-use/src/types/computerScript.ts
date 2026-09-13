import type { ComputerUseSessionClient } from '../services/sessionApiClient';
import type { ComputerUseAction, ComputerUseObservation } from './computerUse';

export interface ComputerScriptProgram {
  observe(): Promise<ComputerUseObservation>;
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
  signal: AbortSignal;
}

export type ComputerScriptRun = (options: ComputerScriptRunContext) => Promise<unknown>;

export interface ComputerScriptExecutionResult {
  result?: unknown;
  observation: ComputerUseObservation;
  logs: readonly string[];
}

export interface ComputerScriptExecutor {
  execute(scriptPath: string, input: unknown, signal?: AbortSignal): Promise<ComputerScriptExecutionResult>;
}

export interface ComputerScriptRunnerOptions {
  readonly client: ComputerUseSessionClient;
  readonly allowedScriptPaths: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}
