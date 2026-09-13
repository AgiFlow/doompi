/** Where the staged presentation and headless payloads live and how they should be started. */
export interface HubLaunchPlan {
  /** Absolute path to the staged doompi-web presentation entry. */
  entry: string;
  /** Absolute path to the staged doompi-server headless entry. */
  headlessEntry: string;
  /** Loopback host the presentation binds and the window loads. */
  host: string;
  /** Port the presentation binds. */
  port: number;
  /** Port the headless process binds for its HTTP and WebSocket protocol. */
  headlessPort: number;
  /** File read by doompi-server for its attach credential. */
  tokenFile: string;
  /** Credential forwarded by doompi-web to the headless process. */
  token: string;
  /**
   * Working directory for the child processes.
   *
   * Set deliberately rather than inherited: DoomPi prefers a DoomPi pinned by
   * the repository it is standing in, so a cockpit that happened to be launched
   * from inside a checkout would silently run that checkout's agent instead of
   * the one this app ships.
   */
  cwd: string;
}

/** The pair of processes this app is responsible for. */
export interface RunningHub {
  url: string;
  owned: boolean;
  stop: () => Promise<void>;
}
