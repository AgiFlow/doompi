const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Exercise the installed sink over a real stdio connection, not a mock. The sink ships only the
// v2 server, so the client is the v2 client from this package's own test dependencies.
async function main() {
  const [manifest, dbPath, directory] = process.argv.slice(2);
  const load = createRequire(__filename);
  const { Client } = await import(pathToFileURL(load.resolve('@modelcontextprotocol/client')).href);
  const { StdioClientTransport } = await import(pathToFileURL(load.resolve('@modelcontextprotocol/client/stdio')).href);
  // The sink serves only the 2026-07-28 revision; a default client opens with a 2025 version.
  const client = new Client(
    { name: 'doompi-metrics-regression', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(path.dirname(manifest), 'dist/cli.mjs'),
      'start',
      '--mcp-only',
      '--db-path',
      dbPath,
      '--registry-path',
      path.join(directory, 'registry'),
    ],
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'search_logs', arguments: { mode: 'fts', service: 'pi', limit: 50 } });
    if (result.isError) throw new Error(JSON.stringify(result));
    process.stdout.write(JSON.stringify(result));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
