import type { HarnessOptions } from '../../composition/types/harness';

export interface ServeOptions {
  /** Start global services without creating an initial session. */
  noSession?: boolean;
  /** File holding the external protocol token, so it never appears in a process listing. */
  tokenFile: string;
  /** Arguments used to configure the direct harness session. */
  agentArgs: string[];
  /** Port for the client-neutral HTTP and WebSocket protocol. */
  webPort: number;
  /** Session name shown in the cockpit rail. */
  sessionName: string;
  /** Session id to mint, or undefined to let the server generate one. */
  sessionId?: string;
}

export interface ServerRuntimeEnvironment {
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  signal: AbortSignal;
  notice: (message: string) => void;
  resolveHarnessOptions: (input: {
    args: readonly string[];
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
  }) => HarnessOptions;
}
