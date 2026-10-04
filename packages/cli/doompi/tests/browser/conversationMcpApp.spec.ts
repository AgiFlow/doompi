import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config';
import { parseDoomMcpBundle } from '@agimon-ai/doompi-core/mcpFacet';
import { readSyncRegistration } from '@agimon-ai/doompi-core/syncRegistration';
import { expect, test } from '@playwright/test';

import { packageRootFor } from '../system/packageMatrix';
import { writeMinimalDoomRepository } from '../system/packHelpers';
import { startScriptedModel } from '../system/support/scriptedModel';

const repository = path.resolve(import.meta.dirname, '../../../../..');
const cli = path.join(repository, 'packages/cli/doompi/dist/bin/cli.mjs');
const execute = promisify(execFile);

// This is deliberately the production owner, not the cockpit admission double.
test('activates a fixture App from a real admitted conversation tool call', async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-conversation-app-'));
  const root = path.join(temporary, 'repo');
  const home = path.join(temporary, 'home');
  const agent = path.join(home, '.pi/agent');
  const exportedHtml = path.join(temporary, 'exported-widget.html');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(agent, { recursive: true });
  const model = await startScriptedModel([
    { toolCalls: [{ id: 'fixture-standard', name: 'fixture_standard', arguments: {} }] },
    { content: 'Conversation App completed.' },
    { toolCalls: [{ id: 'fixture-legacy', name: 'fixture_legacy', arguments: {} }] },
    { content: 'Legacy App completed.' },
    { toolCalls: [{ id: 'fixture-widget', name: 'fixture_doompi_widget', arguments: {} }] },
    { content: 'Exported widget completed.' },
    { content: 'Approved follow-up completed.' },
  ]);
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(DOOMPI_|DOOM_PI_|AGENT_HARNESS_|PI_SUBAGENT_)/u.test(key)) delete environment[key];
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agent,
    DOOMPI_WEB_PACKAGE_ROOT: path.join(repository, 'packages/clients/doompi-web'),
  });
  let server: ReturnType<typeof spawn> | undefined;
  let web: ReturnType<typeof spawn> | undefined;
  let diagnostics = '';
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') browserErrors.push(message.text());
  });
  try {
    const options = { cwd: root, env: environment, maxBuffer: 16 * 1024 * 1024 };
    await execute(process.execPath, [cli, 'init'], options);
    writeMinimalDoomRepository(root);
    fs.writeFileSync(
      path.join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          scripted: {
            baseUrl: model.baseUrl,
            apiKey: 'scripted-test',
            api: 'openai-completions',
            models: [
              {
                id: 'scripted',
                name: 'Scripted',
                reasoning: false,
                input: ['text'],
                contextWindow: 32768,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const modes = fs
      .readFileSync(path.join(import.meta.dirname, '../fixtures/repository/.doom/modes.yaml'), 'utf8')
      .replace(/"(@agimon-ai\/doompi-[a-z-]+)"/gu, (_match, name: string) => JSON.stringify(packageRootFor(name)));
    fs.writeFileSync(path.join(root, '.doom/modes.yaml'), modes);
    fs.writeFileSync(path.join(globalDoomConfigDirectory(home), 'modes.yaml'), modes);
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [path.join(repository, 'packages/default/doompi-mcp/tests/fixtures/mcpAppsServer.mjs'), exportedHtml],
          },
        },
      }),
    );
    await execute(process.execPath, [cli, 'sync', '--global'], options);
    await execute(process.execPath, [cli, 'sync'], options);
    const synced = readSyncRegistration(root, home);
    if (!synced?.mcpBundle) throw new Error('Sync did not publish an MCP bundle');
    const bundle = parseDoomMcpBundle(JSON.parse(fs.readFileSync(synced.mcpBundle.path, 'utf8')));
    if (!bundle.ui) throw new Error('Sync did not export MCP UI HTML');
    fs.copyFileSync(path.resolve(path.dirname(synced.mcpBundle.path), bundle.ui.file), exportedHtml);
    const token = 'conversation-app-test-token';
    const tokenFile = path.join(temporary, 'token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('Missing reserved port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    server = spawn(
      process.execPath,
      [
        path.join(repository, 'packages/cli/doompi/dist/bin/serve.mjs'),
        '--auth-token-file',
        tokenFile,
        '--web',
        String(port),
        '--session-id',
        'conversation-app',
        '--',
        '--provider',
        'scripted',
        '--no-agents',
        '--no-hooks',
        '--model',
        'scripted',
      ],
      { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    server.stdout?.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    server.stderr?.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    await expect
      .poll(
        () => {
          if (server?.exitCode !== null) throw new Error(`Production server exited: ${diagnostics}`);
          return diagnostics;
        },
        { timeout: 120_000 },
      )
      .toContain('protocol on');
    const registration = readSyncRegistration(root, home);
    if (!registration?.webDirectory) throw new Error('Sync did not publish web assets');
    let webDiagnostics = '';
    web = spawn(
      process.execPath,
      [
        path.join(repository, 'packages/clients/doompi-web/dist/bin/serve.mjs'),
        '--port',
        '0',
        '--assets',
        registration.webDirectory,
        '--headless-url',
        `http://127.0.0.1:${port}`,
        '--headless-token',
        token,
      ],
      { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    web.stderr?.on('data', (chunk: Buffer) => {
      webDiagnostics += chunk.toString();
    });
    await expect
      .poll(
        () => {
          if (web?.exitCode !== null) throw new Error(`Web client exited: ${webDiagnostics}`);
          return webDiagnostics;
        },
        { timeout: 30_000 },
      )
      .toContain('serving browser assets at');
    const url = /serving browser assets at (http:\/\/[^\s]+)/u.exec(webDiagnostics)?.[1];
    if (!url) throw new Error('Missing browser URL');
    await page.goto(url);
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await composer.fill('Show the standard fixture App.');
    await page.getByTestId('composer-send').click();
    const requests = await model.waitForRequests(2, 60_000).catch(async (error: unknown) => {
      throw new Error(`${String(error)}\n\nUI: ${await page.locator('body').innerText()}\n\nServer: ${diagnostics}`, {
        cause: error,
      });
    });
    expect(requests[0]?.toolNames).toContain('fixture_standard');
    expect(requests[0]?.toolNames).not.toContain('fixture_app_data');
    expect(JSON.stringify(requests[1]?.messages)).toContain('public result');
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('private-sentinel');
    const standardCard = page.locator('[data-tool-name="fixture_standard"]');
    const standard = standardCard.frameLocator('iframe[title="standard MCP App"]').frameLocator('iframe');
    await expect(standard.getByText('Deterministic App fixture')).toBeVisible({ timeout: 30_000 });
    await expect(standardCard.getByText('Read-only MCP App', { exact: true })).toBeVisible();
    await expect(standard.locator('#result')).toContainText('"invocations":1');
    await expect(standard.locator('#result')).toContainText('private-sentinel');
    await standard.getByRole('button', { name: 'Call data' }).click();
    await expect(standard.locator('#result')).toContainText('Enable interactions');
    await expect(page.getByTestId('dialog-confirm')).toHaveCount(0);
    await standardCard.getByRole('button', { name: 'Enable interactions' }).click();
    await expect(page.getByText('Enable fixture App interactions?', { exact: true })).toBeVisible();
    await page.getByTestId('dialog-confirm').click();
    await expect(standardCard.getByText('MCP App interactions enabled', { exact: true })).toBeVisible();
    await standard.getByRole('button', { name: 'Call data' }).click();
    await expect(page.getByText('Allow fixture App to call app_data?', { exact: true })).toBeVisible();
    await page.getByTestId('dialog-confirm').click();
    await expect(standard.locator('#result')).toContainText('"value":7');
    await expect(standard.locator('#result')).toContainText('"invocations":2');
    expect(model.requests).toHaveLength(2);

    await composer.fill('Show the legacy fixture App.');
    await page.getByTestId('composer-send').click();
    await model.waitForRequests(4, 60_000);
    const legacyCard = page.locator('[data-tool-name="fixture_legacy"]');
    const legacy = legacyCard.frameLocator('iframe[title="legacy MCP App"]').frameLocator('iframe');
    // The first script consumes the injected output and private metadata immediately.
    await expect(legacy.locator('#result')).toContainText('"invocations":3');
    await expect(legacy.locator('#result')).toContainText('private-sentinel');
    await legacy.getByRole('button', { name: 'Save state' }).click();
    await expect(legacy.locator('#state')).toHaveText('{"page":1}');
    await page.reload();
    await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 30_000 });
    await expect(legacy.locator('#state')).toHaveText('{"page":1}');
    await expect(legacy.locator('#result')).toContainText('"invocations":3');
    await expect(legacyCard.getByText('Read-only MCP App', { exact: true })).toBeVisible();
    await expect(standardCard.getByText('Read-only MCP App', { exact: true })).toBeVisible();
    expect(model.requests).toHaveLength(4);

    await composer.fill('Show the exported DoomPi session widget.');
    await page.getByTestId('composer-send').click();
    await model.waitForRequests(6, 60_000);
    const widget = page
      .locator('[data-tool-name="fixture_doompi_widget"]')
      .frameLocator('iframe[title="doompi_widget MCP App"]')
      .frameLocator('iframe');
    await expect(widget.getByRole('heading', { name: 'Doompi session' })).toBeVisible();
    await expect(widget.getByText('exported-session', { exact: true })).toBeVisible();
    await expect(widget.getByText('fixture repository', { exact: true })).toBeVisible();
    await expect(widget.getByText('Default', { exact: true })).toBeVisible();

    await standardCard.getByRole('button', { name: 'Enable interactions' }).click();
    await expect(page.getByText('Enable fixture App interactions?', { exact: true })).toBeVisible();
    await page.getByTestId('dialog-confirm').click();
    await expect(standardCard.getByText('MCP App interactions enabled', { exact: true })).toBeVisible();
    await standard.getByRole('button', { name: 'Call data' }).click();
    await expect(page.getByText('Allow fixture App to call app_data?', { exact: true })).toBeVisible();
    await page.getByTestId('dialog-confirm').click();
    // 1 standard + 1 callback + 1 legacy + 1 exported widget, no replay calls.
    await expect(standard.locator('#result')).toContainText('"invocations":5');
    await standard.getByRole('button', { name: 'Follow up' }).click();
    await expect(page.getByText('Send a follow-up from fixture?', { exact: true })).toBeVisible();
    await page.getByTestId('dialog-confirm').click();
    await model.waitForRequests(7, 60_000);
    await page.getByTestId('timeline-jump').click();
    await expect(page.getByText('Approved follow-up completed.', { exact: true })).toBeVisible();
    expect(
      model.requests[6]?.messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content).includes(
            '[MCP App fixture/standard, invocation fixture-standard]\\nContinue from the approved fixture App.',
          ),
      ),
    ).toBe(true);
    for (const request of model.requests) {
      expect(request.toolNames).not.toContain('fixture_app_data');
      expect(JSON.stringify(request.messages)).not.toContain('private-sentinel');
      expect(JSON.stringify(request.messages)).not.toContain('data-sentinel');
    }
  } catch (error) {
    const diagnosticFile = testInfo.outputPath('conversation-app-diagnostics.txt');
    fs.writeFileSync(
      diagnosticFile,
      `${String(error)}\nServer: ${diagnostics}\nBrowser: ${browserErrors.join('\n')}\nUI: ${await page
        .locator('body')
        .innerText()
        .catch(() => 'unavailable')}\nTools: ${await page
        .getByTestId('entry-tool')
        .evaluateAll((nodes) => nodes.map((node) => node.outerHTML).join('\n'))
        .catch(() => 'unavailable')}`,
    );
    await testInfo.attach('conversation-app-diagnostics', { path: diagnosticFile, contentType: 'text/plain' });
    await page
      .screenshot({ path: testInfo.outputPath('conversation-app-failure.png'), fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await page.close();
    for (const child of [web, server]) {
      if (!child || child.exitCode !== null) continue;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(kill);
    }
    await model.close();
    const history = path.join(agent, 'server', 'sessions');
    if (fs.existsSync(history)) fs.cpSync(history, testInfo.outputPath('session-debug'), { recursive: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
