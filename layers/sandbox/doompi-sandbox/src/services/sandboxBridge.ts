export const BRIDGE_FILE_NAME = 'sandbox-bridge.mjs';
export const BRIDGE_CONTAINER_PATH = `/opt/doompi/${BRIDGE_FILE_NAME}`;
export const BROKER_SOCKET_ENV = 'DOOMPI_BROKER_SOCKET';
export const BROKER_ADDRESS_ENV = 'DOOMPI_BROKER_ADDRESS';
/** Hostname the engine maps to the host, used when the broker listens on TCP. */
export const BROKER_HOST_GATEWAY = 'host.docker.internal';
export const BROKER_PORT_ENV = 'DOOMPI_BROKER_PORT';
export const BROKER_PROVIDERS_ENV = 'DOOMPI_BROKER_PROVIDERS';
/** Fixed inside the container, which has its own loopback namespace. */
export const BROKER_CONTAINER_PORT = 8317;
export const BROKER_SOCKET_CONTAINER_PATH = '/run/doompi/broker.sock';

/**
 * Container-side forwarder from loopback TCP to the mounted broker socket.
 *
 * Provider SDKs issue ordinary HTTP through Node's global fetch, which cannot
 * address a unix socket, and on a virtual machine backed engine cannot reach
 * one at all. Forwarding raw bytes leaves every SDK unmodified whichever way
 * the broker listens. Wrapping the launcher rather than running as a separate
 * service ties the listener's lifetime to the session without an init process.
 */
export function sandboxBridgeSource(): string {
  return [
    "import { spawn } from 'node:child_process';",
    "import net from 'node:net';",
    '',
    `const socketPath = process.env.${BROKER_SOCKET_ENV};`,
    `const address = process.env.${BROKER_ADDRESS_ENV};`,
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
    'function dialBroker() {',
    '  if (socketPath) return net.connect(socketPath);',
    "  const separator = address.lastIndexOf(':');",
    '  return net.connect(Number(address.slice(separator + 1)), address.slice(0, separator));',
    '}',
    '',
    'if ((!socketPath && !address) || !Number.isInteger(port)) {',
    '  startChild((code) => {',
    '    process.exitCode = code;',
    '  });',
    '} else {',
    '  const server = net.createServer((client) => {',
    '    const upstream = dialBroker();',
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
