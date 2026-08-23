export type SandboxEngine = 'docker' | 'podman' | 'nerdctl' | 'finch';

export interface EngineRunOptions {
  /** Pipes this to stdin instead of attaching the session's stdio. */
  input?: string;
}

export interface EngineCaptureResult {
  exitCode: number;
  stdout: string;
}

/** Runs container engine commands with the session's terminal attached. */
export interface EngineProcessRunner {
  run(command: string, args: string[], options?: EngineRunOptions): Promise<number>;
  /** Captures stdout for probes; an unspawnable command reports undefined. */
  capture(command: string, args: string[]): Promise<EngineCaptureResult | undefined>;
}

/** Host facts the plan builder projects into engine arguments. */
export interface SandboxHostFacts {
  /** Both ends of the session are terminals, so the container gets one too. */
  hasTty: boolean;
  platform: string;
  userId?: number;
  groupId?: number;
  /** Stable key derived from the repository path; prefixes container volumes. */
  repoKey: string;
  /** Distribution version, which tags the sandbox image. */
  version: string;
}

/** How a sandboxed container reaches the host broker. */
export type BrokerEndpoint = { transport: 'unix'; socketDirectory: string } | { transport: 'tcp'; port: number };
