import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { shutdownRuntime, startRuntime, writeMinimalDoomRepository } from './packHelpers.ts';
import { type ScriptedModel, startScriptedModel } from './support/scriptedModel.ts';

/**
 * The whole stack, driven by a model that answers from a script.
 *
 * Everything else in the repository tests one surface at a time against a
 * double. This is the only thing that runs the real launcher, the real
 * composition, real Pi, and every DoomPi extension together, and it does so
 * without a network or a bill because `--preset ollama` registers a provider
 * whose base URL comes from the environment (`ollamaProvider.ts`).
 *
 * The strongest assertion here is the tool list. Pi sends it to the model on
 * every request, so it is the composition's own account of what loaded: no log
 * parsing, no process inspection, and no way for a broken extension to look
 * fine.
 */

const REPO_DOOMPI_CLI = fileURLToPath(new URL('../../dist/bin/cli.mjs', import.meta.url));
const CHECKED_IN_MODES = fileURLToPath(new URL('../fixtures/repository/.doom/modes.yaml', import.meta.url));
const TEST_TIMEOUT_MS = 120_000;
/** The turn is one round trip to a local server; a slow machine is still seconds. */
const SETTLE_TIMEOUT_MS = 60_000;

interface Fixture {
  root: string;
  environment: NodeJS.ProcessEnv;
}

const fixtures: string[] = [];
const models: ScriptedModel[] = [];

afterEach(async () => {
  for (const model of models.splice(0)) await model.close();
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A repository DoomPi will launch in, with a home and an agent directory of
 * its own so the run never reads or writes the developer's.
 */
function createFixture(model: ScriptedModel): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-scripted-'));
  fixtures.push(base);
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const agentDirectory = path.join(base, 'agent');
  for (const directory of [root, home, agentDirectory]) fs.mkdirSync(directory, { recursive: true });
  writeMinimalDoomRepository(root);
  fs.copyFileSync(CHECKED_IN_MODES, path.join(root, '.doom', 'modes.yaml'));

  return {
    root,
    environment: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDirectory,
      // The launcher derives DOOMPI_OLLAMA_BASE_URL from this and overwrites
      // whatever was set directly (harnessContext.ts), so this is the seam.
      OLLAMA_BASE_URL: model.baseUrl,
      OLLAMA_API_KEY: 'scripted-system-test',
      // Parent-only DoomPi state must not redirect the child away from this fixture.
      DOOMPI_ROOT: undefined,
      DOOMPI_STATE: undefined,
      DOOMPI_CORDIS_HOST_REQUIRED: undefined,
      DOOMPI_MAJOR_MODE: undefined,
      DOOMPI_LAYERS: undefined,
    },
  };
}

function launchArgs(): string[] {
  return [
    '--preset',
    'ollama',
    '--no-domains',
    '--no-mcp',
    '--no-agents',
    '--no-hooks',
    '--mode',
    'rpc',
    '--no-session',
    '--approve',
    '--model',
    'ollama/scripted',
  ];
}

describe('a composed session against a scripted model', () => {
  it(
    'advertises the tools the composition registered and relays the answer it scripted',
    async () => {
      const model = await startScriptedModel([{ content: 'the script answered' }]);
      models.push(model);
      const fixture = createFixture(model);
      const runtime = startRuntime(REPO_DOOMPI_CLI, launchArgs(), fixture.root, fixture.environment);

      try {
        runtime.send({ id: 'p1', type: 'prompt', message: 'say hello' });
        await runtime.waitForRecord((record) => record.type === 'agent_settled', SETTLE_TIMEOUT_MS);

        const [request] = await model.waitForRequests(1);
        // Pi's own tools plus the ones DoomPi's layers contribute. Naming a few
        // rather than the whole list keeps this from failing on every
        // composition change while still proving the extensions loaded.
        expect(request?.toolNames).toEqual(expect.arrayContaining(['bash', 'read', 'edit', 'grep']));
        expect(request?.toolNames).toEqual(expect.arrayContaining(['task', 'subagent', 'ask_user_question']));
        expect(request?.messages.at(-1)).toMatchObject({ role: 'user' });

        const answer = runtime.records.find(
          (record) =>
            record.type === 'message_end' && (record.message as { role?: string } | undefined)?.role === 'assistant',
        );
        expect(JSON.stringify(answer)).toContain('the script answered');
      } finally {
        await shutdownRuntime(runtime);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs a tool the model called and sends its output back on the next request',
    async () => {
      const model = await startScriptedModel([
        {
          toolCalls: [{ id: 'call-1', name: 'bash', arguments: { command: 'echo scripted-tool-ran' } }],
        },
        { content: 'the tool ran' },
      ]);
      models.push(model);
      const fixture = createFixture(model);
      const runtime = startRuntime(REPO_DOOMPI_CLI, launchArgs(), fixture.root, fixture.environment);

      try {
        runtime.send({ id: 'p1', type: 'prompt', message: 'run the command' });
        await runtime.waitForRecord((record) => record.type === 'agent_settled', SETTLE_TIMEOUT_MS);

        // Two requests: the one that asked for the tool, and the one carrying
        // its result. The second is the whole loop closing.
        const requests = await model.waitForRequests(2);
        const followUp = requests[1];
        expect(JSON.stringify(followUp?.messages)).toContain('scripted-tool-ran');

        const executed = runtime.records.filter((record) => record.type === 'tool_execution_end');
        expect(executed.length).toBeGreaterThan(0);
      } finally {
        await shutdownRuntime(runtime);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
