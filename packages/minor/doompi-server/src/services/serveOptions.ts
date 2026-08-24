export interface ServeOptions {
  socketPath: string;
  /** File holding the attach token, so it never appears in a process listing. */
  tokenFile: string;
  /** Arguments appended to the supervised agent invocation. */
  agentArgs: string[];
  /** Port for the browser cockpit, or undefined to serve no cockpit. */
  webPort?: number;
  /** Session name shown in the cockpit rail. */
  sessionName: string;
  /** Session id to mint, or undefined to let the server generate one. */
  sessionId?: string;
  /** Registry directory override; the default is resolved by the caller. */
  registryDir?: string;
}

const LISTEN_OPTION = '--listen';
const TOKEN_FILE_OPTION = '--auth-token-file';
const WEB_OPTION = '--web';
const NAME_OPTION = '--name';
const SESSION_ID_OPTION = '--session-id';
const REGISTRY_DIR_OPTION = '--registry-dir';
const AGENT_SEPARATOR = '--';
const DEFAULT_WEB_PORT = 7433;
const DEFAULT_SESSION_NAME = 'untitled';

export const SERVE_USAGE = `doompi-server ${LISTEN_OPTION} <socket> ${TOKEN_FILE_OPTION} <file> [${NAME_OPTION} <name>] [${SESSION_ID_OPTION} <id>] [${REGISTRY_DIR_OPTION} <dir>] [${WEB_OPTION} [port]] [${AGENT_SEPARATOR} <agent arguments>]`;

export interface SessionIdentity {
  sessionId: string;
  sessionName: string;
}

/**
 * Settles which session id and name the agent runs under.
 *
 * Pi accepts the same --session-id and --name flags this server does, so a
 * value the caller already put in the agent arguments wins and is read back
 * for the registry record; otherwise the fallback identity is appended. Either
 * way the server knows the session id before the agent even starts.
 */
export function resolveSessionIdentity(
  agentArgs: readonly string[],
  fallback: SessionIdentity,
): { agentArgs: string[]; identity: SessionIdentity } {
  const args = [...agentArgs];
  const identity = { ...fallback };
  for (const [option, key] of [
    [SESSION_ID_OPTION, 'sessionId'],
    [NAME_OPTION, 'sessionName'],
  ] as const) {
    const index = args.indexOf(option);
    const value = index === -1 ? undefined : args[index + 1];
    if (value !== undefined && !value.startsWith('-')) identity[key] = value;
    else args.push(option, identity[key]);
  }
  return { agentArgs: args, identity };
}

/**
 * Parses the server's own arguments, leaving the agent's untouched.
 *
 * The token is read from a file rather than a flag: an argument vector is
 * readable by any local process, which would defeat the socket's permissions.
 */
export function parseServeOptions(argv: readonly string[]): ServeOptions {
  let socketPath: string | undefined;
  let tokenFile: string | undefined;
  let webPort: number | undefined;
  let sessionName: string | undefined;
  let sessionId: string | undefined;
  let registryDir: string | undefined;
  const agentArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === AGENT_SEPARATOR) {
      agentArgs.push(...argv.slice(index + 1));
      break;
    }
    if (argument === WEB_OPTION) {
      // The port is optional, so only consume the next token when it reads as
      // one; otherwise it belongs to whatever flag follows.
      const value = argv[index + 1];
      if (value !== undefined && /^\d+$/u.test(value)) {
        const parsed = Number.parseInt(value, 10);
        if (parsed < 1 || parsed > 65535) throw new Error(`${WEB_OPTION} expects a port number, received "${value}".`);
        webPort = parsed;
        index += 1;
      } else {
        webPort = DEFAULT_WEB_PORT;
      }
      continue;
    }
    if (
      argument === LISTEN_OPTION ||
      argument === TOKEN_FILE_OPTION ||
      argument === NAME_OPTION ||
      argument === SESSION_ID_OPTION ||
      argument === REGISTRY_DIR_OPTION
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value.`);
      if (argument === LISTEN_OPTION) socketPath = value;
      else if (argument === TOKEN_FILE_OPTION) tokenFile = value;
      else if (argument === NAME_OPTION) sessionName = value;
      else if (argument === REGISTRY_DIR_OPTION) registryDir = value;
      else {
        // The id names a registry record file and a Pi session, so a path
        // separator would escape both namespaces.
        if (value.includes('/')) throw new Error(`${SESSION_ID_OPTION} must not contain "/".`);
        sessionId = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${argument}. Usage: ${SERVE_USAGE}`);
  }

  if (!socketPath) throw new Error(`${LISTEN_OPTION} is required. Usage: ${SERVE_USAGE}`);
  if (!tokenFile) throw new Error(`${TOKEN_FILE_OPTION} is required. Usage: ${SERVE_USAGE}`);
  return {
    socketPath,
    tokenFile,
    agentArgs,
    webPort,
    sessionName: sessionName ?? DEFAULT_SESSION_NAME,
    sessionId,
    registryDir,
  };
}
