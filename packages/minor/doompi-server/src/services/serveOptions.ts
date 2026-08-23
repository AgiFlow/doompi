export interface ServeOptions {
  socketPath: string;
  /** File holding the attach token, so it never appears in a process listing. */
  tokenFile: string;
  /** Arguments appended to the supervised agent invocation. */
  agentArgs: string[];
}

const LISTEN_OPTION = '--listen';
const TOKEN_FILE_OPTION = '--auth-token-file';
const AGENT_SEPARATOR = '--';

export const SERVE_USAGE = `doompi-server ${LISTEN_OPTION} <socket> ${TOKEN_FILE_OPTION} <file> [${AGENT_SEPARATOR} <agent arguments>]`;

/**
 * Parses the server's own arguments, leaving the agent's untouched.
 *
 * The token is read from a file rather than a flag: an argument vector is
 * readable by any local process, which would defeat the socket's permissions.
 */
export function parseServeOptions(argv: readonly string[]): ServeOptions {
  let socketPath: string | undefined;
  let tokenFile: string | undefined;
  const agentArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === AGENT_SEPARATOR) {
      agentArgs.push(...argv.slice(index + 1));
      break;
    }
    if (argument === LISTEN_OPTION || argument === TOKEN_FILE_OPTION) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${argument} requires a value.`);
      if (argument === LISTEN_OPTION) socketPath = value;
      else tokenFile = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${argument}. Usage: ${SERVE_USAGE}`);
  }

  if (!socketPath) throw new Error(`${LISTEN_OPTION} is required. Usage: ${SERVE_USAGE}`);
  if (!tokenFile) throw new Error(`${TOKEN_FILE_OPTION} is required. Usage: ${SERVE_USAGE}`);
  return { socketPath, tokenFile, agentArgs };
}
