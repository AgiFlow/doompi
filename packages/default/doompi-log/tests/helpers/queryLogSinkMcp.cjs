const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Exercise the installed sink's own MCP transport dependency graph, not a mock
// or an independently versioned SDK supplied by DoomPi.
async function main() {
  const [manifest, dbPath, directory] = process.argv.slice(2);
  const load = createRequire(manifest);
  const { Client } = await import(pathToFileURL(load.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(
    pathToFileURL(load.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
  );
  const client = new Client({ name: 'doompi-metrics-regression', version: '1.0.0' });
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
