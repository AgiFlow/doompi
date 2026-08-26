const COCKPIT_PACKAGE = '@agimon-ai/doompi-web';
const HUB_ROLE = 'hub';
const PROBE_TIMEOUT_MS = 1000;

export interface CockpitOptions {
  /** Registry the cockpit watches; this session's record is its registration. */
  registryDir: string;
  port: number;
}

export interface CockpitHandle {
  readonly url: string;
  close(): Promise<void>;
}

interface CockpitModule {
  serveWeb(options: {
    registryDir: string;
    port: number;
    host?: string;
    onNotice?: (message: string) => void;
  }): Promise<CockpitHandle>;
}

type CockpitLoader = () => Promise<CockpitModule>;

/** Resolves a Web module supplied by a distribution wrapper, or the package name for direct installs. */
export function cockpitModuleSpecifier(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DOOMPI_WEB_MODULE || COCKPIT_PACKAGE;
}

async function loadInstalledCockpit(): Promise<CockpitModule> {
  return (await import(cockpitModuleSpecifier())) as CockpitModule;
}

/** True when a DoomPi cockpit hub already answers on the port. */
async function probeHub(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean; role?: string };
    return body.ok === true && body.role === HUB_ROLE;
  } catch {
    return false;
  }
}

function existingHubHandle(port: number, onNotice?: (message: string) => void): CockpitHandle {
  const url = `http://127.0.0.1:${port}`;
  onNotice?.(`cockpit already running at ${url}; this session will appear there`);
  return { url, close: () => Promise.resolve() };
}

/**
 * Ensures a browser cockpit is reachable for this session.
 *
 * The cockpit is a multi-session hub, so only one process needs to host it: if
 * a hub already answers on the port, this session just points at it (the
 * registry record makes it appear there). Otherwise the hub starts in-process,
 * loaded on demand rather than imported, so a server that is never asked for
 * `--web` neither pays for it nor requires it to be installed. An embedded hub
 * dies with its server; a standalone `doompi-web` is the durable topology.
 */
export async function startWebCockpit(
  options: CockpitOptions,
  onNotice?: (message: string) => void,
  loadCockpit: CockpitLoader = loadInstalledCockpit,
): Promise<CockpitHandle> {
  if (await probeHub(options.port)) return existingHubHandle(options.port, onNotice);

  let module: CockpitModule;
  try {
    module = await loadCockpit();
  } catch {
    throw new Error(`--web needs ${COCKPIT_PACKAGE}. Install it, or start the server without --web.`);
  }
  try {
    return await module.serveWeb({ ...options, host: '127.0.0.1', onNotice });
  } catch (error) {
    // Two servers starting at once can both find the port free; the loser
    // re-probes and settles for pointing at the winner.
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      if (await probeHub(options.port)) return existingHubHandle(options.port, onNotice);
      throw new Error(`Port ${options.port} is taken by something that is not a DoomPi cockpit.`);
    }
    throw error;
  }
}
