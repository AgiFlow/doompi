import fs from 'node:fs';

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new McpServer({ name: 'doompi-apps-fixture', version: '1.0.0' });
let invocations = 0;
const pending = { tool: 0, resource: 0 };
const cancelled = { tool: 0, resource: 0 };
async function waitForCancellation(ctx, kind) {
  pending[kind]++;
  await new Promise((resolve) => {
    const stop = () => {
      cancelled[kind]++;
      resolve();
    };
    if (ctx.mcpReq.signal.aborted) stop();
    else ctx.mcpReq.signal.addEventListener('abort', stop, { once: true });
  });
}
function appHtml(protocol) {
  const script =
    protocol === 'legacy'
      ? `
    const showState = () => document.querySelector('#state').textContent = JSON.stringify(window.openai.widgetState);
    show({ structuredContent: window.openai.toolOutput, _meta: window.openai.toolResponseMetadata });
    showState();
    document.querySelector('#call').onclick = async () => {
      try { show(await window.openai.callTool('app_data')); } catch (error) { show({ error: error.message }); }
    };
    document.querySelector('#save').onclick = async () => {
      await window.openai.setWidgetState({ page: (window.openai.widgetState?.page ?? 0) + 1 });
      showState();
    };
  `
      : `
    const send = (data) => parent.postMessage({ jsonrpc: '2.0', ...data }, '*');
    let nextId = 1;
    window.addEventListener('message', ({ source, data }) => {
      if (source !== parent || data?.jsonrpc !== '2.0') return;
      if (data.id === 'init' && data.result) send({ method: 'ui/notifications/initialized', params: {} });
      else if (data.method === 'ui/notifications/tool-result') show(data.params);
      else if (data.result) show(data.result);
      else if (data.error) show({ error: data.error.message });
    });
    document.querySelector('#follow').onclick = () => send({ id: nextId++, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Continue from the approved fixture App.' }] } });
    document.querySelector('#call').onclick = () => send({ id: nextId++, method: 'tools/call', params: { name: 'app_data', arguments: {} } });
    send({ id: 'init', method: 'ui/initialize', params: {
      appInfo: { name: 'Fixture', version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26',
    } });
  `;
  return `<!doctype html><html><body><h1>Deterministic App fixture</h1>
    <button id="call">Call data</button>${protocol === 'legacy' ? '<button id="save">Save state</button>' : ''}
    <button id="follow">Follow up</button><output id="result"></output><output id="state"></output>
    <script>const show = (value) => { document.querySelector('#result').textContent = JSON.stringify({ ...value.structuredContent, private: value._meta?.['fixture/private'], error: value.error }); };${script}</script>
  </body></html>`;
}
for (const [name, mimeType] of [
  ['standard', 'text/html;profile=mcp-app'],
  ['legacy', 'text/html+skybridge'],
]) {
  const uri = `ui://fixture/${name}.html`;
  server.registerResource(name, uri, { mimeType }, async () => ({
    contents: [
      {
        uri,
        mimeType,
        text: appHtml(name),
        _meta: { 'fixture/private': 'resource-sentinel' },
      },
    ],
  }));
  server.registerTool(
    name,
    {
      description: `${name} presentation`,
      _meta: name === 'standard' ? { ui: { resourceUri: uri } } : { 'openai/outputTemplate': uri },
    },
    async () => ({
      content: [{ type: 'text', text: 'public result' }],
      structuredContent: { invocations: ++invocations },
      _meta: { 'fixture/private': 'private-sentinel', payload: 'x'.repeat(20_000) },
    }),
  );
}
server.registerTool('app_data', { _meta: { ui: { visibility: ['app'] } } }, async () => ({
  content: [{ type: 'text', text: JSON.stringify(7) }],
  structuredContent: { value: 7, invocations: ++invocations },
  _meta: { 'fixture/private': 'data-sentinel' },
}));
server.registerTool('model_data', { _meta: { ui: { visibility: ['model'] } } }, async () => ({
  content: [{ type: 'text', text: 'model only' }],
}));
server.registerTool('oversized', { _meta: { ui: { resourceUri: 'ui://fixture/standard.html' } } }, async () => ({
  content: [{ type: 'text', text: 'large public result '.repeat(10_000) }],
  structuredContent: { payload: 'x'.repeat(100_000) },
  _meta: { 'fixture/private': 'oversized-sentinel' },
}));
server.registerTool('slow_view', { _meta: { ui: { resourceUri: 'ui://fixture/slow.html' } } }, async (ctx) => {
  await waitForCancellation(ctx, 'tool');
  return { content: [] };
});
server.registerResource(
  'slow',
  'ui://fixture/slow.html',
  { mimeType: 'text/html;profile=mcp-app' },
  async (_uri, ctx) => {
    await waitForCancellation(ctx, 'resource');
    return { contents: [] };
  },
);
server.registerTool('inspect', {}, async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({ invocations, capabilities: server.server.getClientCapabilities(), pending, cancelled }),
    },
  ],
}));
if (process.argv[2]) {
  const uri = 'ui://fixture/doompi-widget.html';
  const html = fs.readFileSync(process.argv[2], 'utf8');
  const metadata = { ui: { resourceUri: uri }, 'doompi/widget': '@agimon-ai/doompi-config/show_session' };
  server.registerResource('doompi_widget', uri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
    contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: html }],
  }));
  server.registerTool(
    'doompi_widget',
    { description: 'Exported DoomPi session widget', _meta: metadata },
    async () => ({
      content: [{ type: 'text', text: 'Exported session summary' }],
      structuredContent: {
        sessionId: 'exported-session',
        repositoryName: 'fixture repository',
        profile: null,
        revision: ++invocations,
        majorMode: 'copilot',
        domains: [],
        layers: [],
        minorModes: [],
      },
      _meta: metadata,
    }),
  );
}
// structuredContent is an object in this SDK. Primitive JSON is represented in text.
await server.connect(new StdioServerTransport());
