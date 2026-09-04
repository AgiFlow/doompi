import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);

function argument(flag) {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value === '') throw new Error(`Missing fake hub argument ${flag}`);
  return value;
}

const host = argument('--host');
const port = Number(argument('--port'));
const registryDirectory = argument('--registry-dir');
const markerPath = process.env.DESKTOP_E2E_HUB_MARKER;
if (markerPath === undefined || markerPath === '') throw new Error('Missing DESKTOP_E2E_HUB_MARKER');
if (!Number.isInteger(port) || port < 1) throw new Error(`Invalid fake hub port ${String(port)}`);
fs.mkdirSync(registryDirectory, { recursive: true });
fs.mkdirSync(path.dirname(markerPath), { recursive: true });

function record(event) {
  fs.appendFileSync(markerPath, `${JSON.stringify({ event, pid: process.pid })}\n`);
}

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>DoomPi desktop fake hub</title>
  </head>
  <body>
    <main data-testid="fake-hub">
      <h1>DoomPi desktop fake hub</h1>
      <p data-testid="hub-status">ready</p>
      <a data-testid="same-origin-link" href="/same-origin">same origin</a>
      <button data-testid="external-window" type="button" onclick="window.open('http://outside.invalid/window')">external window</button>
    </main>
  </body>
</html>`;
const sameOriginPage = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>same-origin navigation</title></head>
  <body><main data-testid="same-origin-page"><h1>Same-origin navigation succeeded</h1></main></body>
</html>`;

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${host}:${String(port)}`);
  if (requestUrl.pathname === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (requestUrl.pathname === '/same-origin') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(sameOriginPage);
    return;
  }
  if (requestUrl.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  record('stopping');
  server.close(() => {
    record('stopped');
    process.exit(0);
  });
  server.closeAllConnections();
}

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
server.once('error', (error) => {
  fs.appendFileSync(markerPath, `${JSON.stringify({ event: 'error', message: String(error) })}\n`);
  process.exit(1);
});
server.listen(port, host, () => record('started'));
