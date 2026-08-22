/** Derives a stable, readable runner name that no live runner already holds. */
export interface IRunnerNamer {
  /**
   * Returns `requested` when it is free, otherwise a numbered variant.
   * With no `requested` name, one is derived from the command line.
   */
  allocate(command: string, sessionId: string, requested?: string): Promise<string>;
}
