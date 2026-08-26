import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { standardExtensionScenarios } from '../../src/adapters/testing/extensionContract.ts';
import { createPiTestHost } from '../../src/adapters/testing/piHost.ts';

function tool(name: string) {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  };
}

/** A well-behaved standard entry: registers, cleans up, and reinstalls. */
function goodExtension(pi: ExtensionAPI): void {
  let active = true;
  pi.registerTool(tool('demo_tool'));
  pi.registerCommand('demo', { handler: async () => undefined });
  pi.on('session_shutdown', () => {
    active = false;
    return undefined;
  });
  pi.on('session_start', () => (active ? undefined : undefined));
}

async function run(scenarios: readonly { name: string; run(): Promise<void> }[], name: string): Promise<void> {
  const scenario = scenarios.find((candidate) => candidate.name.includes(name));
  if (!scenario) throw new Error(`No scenario matching '${name}'.`);
  await scenario.run();
}

describe('the standard extension contract', () => {
  const scenarios = standardExtensionScenarios({
    factory: goodExtension,
    tools: ['demo_tool'],
    commands: ['demo'],
  });

  it('passes every scenario for an entry that keeps the contract', async () => {
    for (const scenario of scenarios) await scenario.run();

    expect(scenarios.map(({ name }) => name)).toHaveLength(5);
  });

  it('names the tool an entry forgot to register', async () => {
    const missing = standardExtensionScenarios({
      factory: (pi) => {
        pi.on('session_shutdown', () => undefined);
      },
      tools: ['demo_tool'],
    });

    await expect(run(missing, 'registers its declared tools')).rejects.toThrow(
      'Expected the entry to register tools demo_tool; the entry registered nothing.',
    );
  });

  it('catches an entry that registers no shutdown handler', async () => {
    const leaky = standardExtensionScenarios({
      factory: (pi) => {
        pi.registerTool(tool('demo_tool'));
      },
      tools: ['demo_tool'],
    });

    await expect(run(leaky, 'handles session_shutdown')).rejects.toThrow('nothing it holds is ever released');
  });

  it('catches a shutdown that fails the second time it is delivered', async () => {
    const brittle = standardExtensionScenarios({
      factory: (pi) => {
        let disposed = false;
        pi.on('session_shutdown', () => {
          if (disposed) throw new Error('already disposed');
          disposed = true;
          return undefined;
        });
      },
    });

    await expect(run(brittle, 'repeated shutdown')).rejects.toThrow('already disposed');
  });

  it('catches a module-level latch that survives a reload', async () => {
    let installed = false;
    const latched = standardExtensionScenarios({
      factory: (pi) => {
        if (installed) return;
        installed = true;
        pi.registerTool(tool('demo_tool'));
        pi.on('session_shutdown', () => undefined);
      },
      tools: ['demo_tool'],
    });

    // This is the failure the launcher's stable-entry path exists to avoid: an
    // entry that quietly does nothing on the second load leaves /reload inert.
    await expect(run(latched, 'loads again on the same host')).rejects.toThrow('a module-level latch is surviving');
  });

  it('catches an entry that needs a terminal', async () => {
    const terminalBound = standardExtensionScenarios({
      factory: (pi) => {
        pi.registerTool(tool('demo_tool'));
        pi.on('session_start', (_event, context) => {
          if (!context.hasUI) throw new Error('no terminal is attached');
          return undefined;
        });
        pi.on('session_shutdown', () => undefined);
      },
      tools: ['demo_tool'],
    });

    await expect(run(terminalBound, 'headless host')).rejects.toThrow('no terminal is attached');
  });

  it('builds each scenario its own host, so one cannot leak into the next', async () => {
    const sessions: string[] = [];
    const scoped = standardExtensionScenarios({
      factory: (pi) => {
        pi.on('session_shutdown', () => undefined);
      },
      createHost: (options) => {
        sessions.push(options.hasUI === false ? 'headless' : 'default');
        return createPiTestHost(options);
      },
    });

    for (const scenario of scoped) await scenario.run();

    expect(sessions).toEqual(['default', 'default', 'default', 'default', 'headless']);
  });
});
