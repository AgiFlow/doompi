/** One newline-delimited JSON frame, kept opaque so Pi can evolve its protocol. */
export type SessionFrame = Record<string, unknown>;

/** The supervised agent process the server owns. */
export interface AgentProcess {
  /** Sends one command frame to the agent. */
  send(frame: SessionFrame): void;
  /** Receives every frame the agent emits. */
  onFrame(listener: (frame: SessionFrame) => void): void;
  /** Resolves with the agent's exit code. */
  readonly exited: Promise<number>;
  /** Ends the agent's input stream, asking it to flush and exit gracefully. */
  endInput(): void;
  stop(): void;
}

export interface AgentProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type AgentProcessFactory = (options: AgentProcessOptions) => AgentProcess;
