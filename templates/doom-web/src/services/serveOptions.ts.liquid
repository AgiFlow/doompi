import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';

export interface ServeOptions {
  port: number;
  host: string;
  assetsDir?: string;
  /** Client-neutral headless HTTP/WebSocket endpoint. */
  headlessUrl?: string;
  /** Credential forwarded to the headless endpoint. */
  headlessToken?: string;
  help: boolean;
  version: boolean;
}

const DEFAULT_PORT = 7433;
const DEFAULT_HOST = '127.0.0.1';

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
  return value;
}

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  assets: { type: 'string' },
  'headless-url': { type: 'string' },
  'headless-token': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const satisfies ParseArgsOptionsConfig;

/** Parses the presentation server's small set of transport and asset overrides. */
export function parseServeOptions(argv: readonly string[]): ServeOptions {
  const { tokens } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    strict: false,
    tokens: true,
    allowPositionals: true,
  });

  const values = new Map<string, string>();
  let help = false;
  let version = false;
  for (const token of tokens) {
    if (token.kind === 'positional') throw new Error(`Unknown option "${token.value}".`);
    if (token.kind !== 'option') continue;
    if (token.name === 'help') {
      help = true;
      continue;
    }
    if (token.name === 'version') {
      version = true;
      continue;
    }
    if (!Object.hasOwn(OPTIONS, token.name)) throw new Error(`Unknown option "${token.rawName}".`);
    values.set(token.name, requireValue(`--${token.name}`, token.value));
  }

  let port = DEFAULT_PORT;
  const rawPort = values.get('port');
  if (rawPort !== undefined) {
    const parsed = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`--port expects a port number, received "${rawPort}".`);
    }
    port = parsed;
  }

  return {
    port,
    host: values.get('host') ?? DEFAULT_HOST,
    assetsDir: values.get('assets'),
    headlessUrl: values.get('headless-url'),
    headlessToken: values.get('headless-token'),
    help,
    version,
  };
}

export function serveHelp(): string {
  return `Usage: doompi-web [options]\n\nOptions:\n  --port <number>          HTTP port (default: 7433)\n  --host <address>         Bind address (default: 127.0.0.1)\n  --assets <path>          Override the built SPA directory\n  --headless-url <url>     Headless endpoint (default: http://127.0.0.1:7434)\n  --headless-token <token> Credential forwarded to the headless server\n  -h, --help               Show this help\n  -v, --version            Show the package version\n`;
}
