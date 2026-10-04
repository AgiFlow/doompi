import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_ENV_VAR } from '../src/schemas/sessionConfig';
import { isAppVisibleMcpTool, isModelVisibleMcpTool, normalizeMcpAppMetadata } from '../src/services/mcpCatalog';
import { McpSession } from '../src/services/mcpSession';
import { toHeadlessToolResult } from '../src/services/mcpTools';

const sessions: McpSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function connectedSession() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-apps-transport-'));
  directories.push(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/mcpAppsServer.mjs', import.meta.url))],
        },
      },
    }),
  );
  const session = new McpSession({
    environment: { [SESSION_ENV_VAR]: JSON.stringify({ repoRoot, stagingDirectory: path.join(repoRoot, '.staging') }) },
    tokenStore: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
  });
  sessions.push(session);
  session.install();
  await session.start();
  await session.getClientManager()?.ensureConnected('fixture');
  await vi.waitFor(() => expect(session.activeToolDefinitions()).toHaveLength(7), { timeout: 15_000 });
  return session;
}

describe('published proxy real stdio MCP Apps transport', () => {
  it('discovers both declarations, fences resource reads, and filters tool visibility', async () => {
    const session = await connectedSession();
    const tools = session.activeToolDefinitions();
    for (const name of ['standard', 'legacy']) {
      const tool = tools.find((candidate) => candidate.toolName === name)!;
      const metadata = normalizeMcpAppMetadata(tool._meta);
      expect(metadata.resourceUri).toBe(`ui://fixture/${name}.html`);
      expect(metadata.protocol).toBe(name === 'standard' ? 'mcp' : 'openai');
      const resource = await session.readAppResource('fixture', name, metadata.resourceUri!);
      expect(resource.contents[0]).toMatchObject({
        uri: metadata.resourceUri,
        text: expect.stringContaining('Deterministic App fixture'),
      });
    }
    expect(tools.filter(isModelVisibleMcpTool).map((tool) => tool.toolName)).not.toContain('app_data');
    expect(tools.filter(isAppVisibleMcpTool).map((tool) => tool.toolName)).not.toContain('model_data');
    await expect(session.readAppResource('fixture', 'standard', 'ui://fixture/legacy.html')).rejects.toThrow(
      'not available',
    );
  }, 30_000);

  it('calls through the session once, retains private metadata, and negotiates published Apps capabilities', async () => {
    const session = await connectedSession();
    const tools = session.activeToolDefinitions();
    const standard = tools.find((tool) => tool.toolName === 'standard')!;
    const result = await session.callTool(standard, {});
    expect(result.structuredContent).toEqual({ invocations: 1 });
    expect(result._meta).toMatchObject({ 'fixture/private': 'private-sentinel', payload: 'x'.repeat(20_000) });
    const data = await session.callTool(
      tools.find((tool) => tool.toolName === 'app_data')!,
      {},
    );
    expect(data.content[0]).toMatchObject({ type: 'text', text: '7' });
    expect(data._meta).toMatchObject({ 'fixture/private': 'data-sentinel' });
    const inspect = await session.callTool(
      tools.find((tool) => tool.toolName === 'inspect')!,
      {},
    );
    const text = inspect.content.find((item) => item.type === 'text');
    expect(text?.type).toBe('text');
    const observed: unknown = JSON.parse(text?.type === 'text' ? text.text : '{}');
    expect(observed).toMatchObject({
      invocations: 2,
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app', 'text/html+skybridge'] },
        },
      },
    });
  }, 30_000);
  it('retains the original private result before the published proxy guards model output', async () => {
    const session = await connectedSession();
    vi.stubEnv('TMPDIR', directories.at(-1)!);
    const tool = session.activeToolDefinitions().find((candidate) => candidate.toolName === 'oversized')!;
    const result = toHeadlessToolResult(tool, await session.callTool(tool, {}));
    expect(result.details.app?.result.content).toEqual([{ type: 'text', text: 'large public result '.repeat(10_000) }]);
    expect(result.details.app?.result.structuredContent).toEqual({ payload: 'x'.repeat(100_000) });
    expect(result.details.app?.result._meta).toEqual({ 'fixture/private': 'oversized-sentinel' });
    expect(result.structuredContent).not.toEqual(result.details.app?.result.structuredContent);
    expect(JSON.stringify(result.content).length).toBeLessThan(60_000);
    expect(JSON.stringify(result.content)).not.toContain('oversized-sentinel');
  }, 30_000);

  it('propagates cancellation to in-flight upstream tool and resource requests', async () => {
    const session = await connectedSession();
    const tools = session.activeToolDefinitions();
    const tool = tools.find((candidate) => candidate.toolName === 'slow_view')!;
    const inspect = async () => {
      const result = await session.callTool(
        tools.find((candidate) => candidate.toolName === 'inspect')!,
        {},
      );
      const content = result.content[0];
      if (content?.type !== 'text') throw new Error('Expected inspection result');
      return JSON.parse(content.text) as { pending: Record<string, number>; cancelled: Record<string, number> };
    };
    for (const kind of ['tool', 'resource'] as const) {
      const controller = new AbortController();
      const request =
        kind === 'tool'
          ? session.callTool(tool, {}, controller.signal)
          : session.readAppResource('fixture', 'slow_view', 'ui://fixture/slow.html', controller.signal);
      const rejected = expect(request).rejects.toThrow();
      await vi.waitFor(async () => expect((await inspect()).pending[kind]).toBe(1));
      controller.abort();
      await rejected;
      await vi.waitFor(async () => expect((await inspect()).cancelled[kind]).toBe(1));
    }
  }, 30_000);
});
