export const BRIDGE_FILE_NAME = 'sandbox-bridge.mjs';
export const BRIDGE_CONTAINER_PATH = `/opt/doompi/${BRIDGE_FILE_NAME}`;
export const BROKER_SOCKET_ENV = 'DOOMPI_BROKER_SOCKET';
export const BROKER_PORT_ENV = 'DOOMPI_BROKER_PORT';
export const BROKER_PROVIDERS_ENV = 'DOOMPI_BROKER_PROVIDERS';
/** Fixed inside the container, which has its own loopback namespace. */
export const BROKER_CONTAINER_PORT = 8317;
export const BROKER_SOCKET_CONTAINER_PATH = '/run/doompi/broker.sock';

/**
 * Container-side forwarder from loopback TCP to the mounted broker socket.
 *
 * Provider SDKs issue ordinary HTTP through Node's global fetch, which cannot
 * address a unix socket. Forwarding raw bytes keeps the host socket the only
 * egress the container needs while leaving every SDK unmodified. Wrapping the
 * launcher rather than running as a separate service ties the listener's
 * lifetime to the session without an init process.
 */
export function sandboxBridgeSource(): string {
  return [
    "import { spawn } from 'node:child_process';",
    "import net from 'node:net';",
    '',
    `const socketPath = process.env.${BROKER_SOCKET_ENV};`,
    `const port = Number(process.env.${BROKER_PORT_ENV});`,
    'const [command, ...args] = process.argv.slice(2);',
    '',
    'function startChild(whenDone) {',
    "  const child = spawn(command, args, { stdio: 'inherit' });",
    "  child.on('exit', (code, signal) => whenDone(code ?? (signal ? 1 : 0)));",
    "  child.on('error', (error) => {",
    '    process.stderr.write(`[doompi] sandbox bridge: ${error.message}\\n`);',
    '    whenDone(127);',
    '  });',
    '}',
    '',
    'if (!socketPath || !Number.isInteger(port)) {',
    '  startChild((code) => {',
    '    process.exitCode = code;',
    '  });',
    '} else {',
    '  const server = net.createServer((client) => {',
    '    const upstream = net.connect(socketPath);',
    "    client.on('error', () => upstream.destroy());",
    "    upstream.on('error', () => client.destroy());",
    '    client.pipe(upstream);',
    '    upstream.pipe(client);',
    '  });',
    "  server.listen(port, '127.0.0.1', () => {",
    '    startChild((code) => {',
    '      server.close();',
    '      process.exitCode = code;',
    '    });',
    '  });',
    '}',
    '',
  ].join('\n');
}
