import type { ServeOptions } from '../../builders/server/types';
export type { ServeOptions } from '../../builders/server/types';
export {
  resolveSessionIdentity,
  relaunchAgentArgs,
  type SessionIdentity,
} from '../../builders/server/sessionArguments';
const TOKEN_FILE_OPTION = '--auth-token-file';
const WEB_OPTION = '--web';
const NAME_OPTION = '--name';
const SESSION_ID_OPTION = '--session-id';
const AGENT_SEPARATOR = '--';
const DEFAULT_WEB_PORT = 7433;
const DEFAULT_SESSION_NAME = 'untitled';

export const SERVE_USAGE = `doompi-server ${TOKEN_FILE_OPTION} <file> [--no-session] [${NAME_OPTION} <name>] [${SESSION_ID_OPTION} <id>] [${WEB_OPTION} [port]] [${AGENT_SEPARATOR} <agent arguments>]`;

/**
 * Parses the server's own arguments, leaving the agent's untouched.
 *
 * The token is read from a file rather than a flag because command arguments are visible to other local processes.
 */
export function parseServeOptions(argv: readonly string[]): ServeOptions {
  let noSession = false;
  let tokenFile: string | undefined;
  let webPort = DEFAULT_WEB_PORT;
  let sessionName: string | undefined;
  let sessionId: string | undefined;
  const agentArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--no-session') {
      noSession = true;
      continue;
    }
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
    if (argument === TOKEN_FILE_OPTION || argument === NAME_OPTION || argument === SESSION_ID_OPTION) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value.`);
      if (argument === TOKEN_FILE_OPTION) tokenFile = value;
      else if (argument === NAME_OPTION) sessionName = value;
      else {
        if (value.includes('/')) throw new Error(`${SESSION_ID_OPTION} must not contain "/".`);
        sessionId = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${argument}. Usage: ${SERVE_USAGE}`);
  }

  if (!tokenFile) throw new Error(`${TOKEN_FILE_OPTION} is required. Usage: ${SERVE_USAGE}`);
  return {
    ...(noSession ? { noSession: true } : {}),
    tokenFile,
    agentArgs,
    webPort,
    sessionName: sessionName ?? DEFAULT_SESSION_NAME,
    sessionId,
  };
}
