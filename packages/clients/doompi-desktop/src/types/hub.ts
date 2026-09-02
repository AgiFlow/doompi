/** Where the staged cockpit payload lives and how it should be started. */
export interface HubLaunchPlan {
  /** Absolute path to the hub's `dist/bin/serve.mjs`. */
  entry: string;
  /** Loopback host the cockpit binds and the window loads. */
  host: string;
  /** Port the cockpit binds. */
  port: number;
  /** Session registry directory, kept short for unix socket budget reasons. */
  registryDir: string;
  /**
   * Working directory for the cockpit process.
   *
   * Set deliberately rather than inherited: DoomPi prefers a DoomPi pinned by
   * the repository it is standing in, so a cockpit that happened to be launched
   * from inside a checkout would silently run that checkout's agent instead of
   * the one this app ships.
   */
  cwd: string;
}

/** A hub this app is responsible for, or one it decided to share. */
export interface RunningHub {
  url: string;
  /** False when an existing cockpit answered and this app attached instead. */
  owned: boolean;
  stop: () => Promise<void>;
}
