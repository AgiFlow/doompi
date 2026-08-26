import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createPiTestHost, type PiTestHost, type PiTestHostOptions } from './piHost.ts';

/**
 * The lifecycle every standard Pi entry owes its host, as runnable scenarios.
 *
 * Eight packages carry their own partial copy of this, and the copies disagree
 * about which parts matter. What they share is what a host actually depends on:
 * that loading the entry registers something, that shutdown can be delivered
 * twice, and that a `/reload` can install the entry again on the same runner.
 *
 * Scenarios are plain data, not `describe`/`it` calls, so this adds no test
 * framework to a package every extension already installs. A caller loops:
 *
 * ```ts
 * for (const scenario of standardExtensionScenarios({ factory, tools: ['x'] })) {
 *   it(scenario.name, () => scenario.run());
 * }
 * ```
 *
 * Deeper fencing is deliberately not here. A package that makes a shut-down
 * tool answer instead of run owns that message and that decision, so it keeps
 * the test too; this covers only what is true of every extension.
 */

export interface StandardExtensionContractOptions {
  /** The package's standard Pi entry: the default export Pi invokes. */
  factory(pi: ExtensionAPI): Promise<void> | void;
  /** Tool names loading the entry must register. */
  tools?: readonly string[];
  /** Slash commands loading the entry must claim. */
  commands?: readonly string[];
  /** A fresh host per scenario, for a factory that needs one stubbed a certain way. */
  createHost?: (options: PiTestHostOptions) => PiTestHost;
}

export interface ExtensionContractScenario {
  name: string;
  run(): Promise<void>;
}

const SHUTDOWN_EVENT = 'session_shutdown';
const START_EVENT = 'session_start';

function fail(message: string): never {
  throw new Error(message);
}

function assertContains(actual: readonly string[], expected: readonly string[], subject: string): void {
  const missing = expected.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    fail(`Expected ${subject} ${missing.join(', ')}; the entry registered ${actual.join(', ') || 'nothing'}.`);
  }
}

export function standardExtensionScenarios(
  options: StandardExtensionContractOptions,
): readonly ExtensionContractScenario[] {
  const expectedTools = options.tools ?? [];
  const expectedCommands = options.commands ?? [];
  const build = options.createHost ?? createPiTestHost;

  /** Runs one scenario against its own host, and disposes it either way. */
  const scenario = (
    name: string,
    hostOptions: PiTestHostOptions,
    body: (host: PiTestHost) => Promise<void>,
  ): ExtensionContractScenario => ({
    name,
    async run() {
      const host = build(hostOptions);
      try {
        await body(host);
      } finally {
        await host.dispose();
      }
    },
  });

  return [
    scenario('registers its declared tools and commands when the host loads it', {}, async (host) => {
      await options.factory(host.pi);

      assertContains(
        host.tools.map(({ name }) => name),
        expectedTools,
        'the entry to register tools',
      );
      assertContains(
        host.commands.map(({ name }) => name),
        expectedCommands,
        'the entry to claim commands',
      );
    }),

    scenario('handles session_shutdown, so the host can reclaim what it registered', {}, async (host) => {
      await options.factory(host.pi);

      if (host.handlers(SHUTDOWN_EVENT).length === 0) {
        fail('The entry registered no session_shutdown handler, so nothing it holds is ever released.');
      }
    }),

    scenario('takes a repeated shutdown without failing the second one', {}, async (host) => {
      // Pi delivers shutdown per registered extension, and a package that
      // installed twice on one runner receives it twice.
      await options.factory(host.pi);

      await host.emit(SHUTDOWN_EVENT, { reason: 'quit' });
      await host.emit(SHUTDOWN_EVENT, { reason: 'quit' });
    }),

    scenario('loads again on the same host after a shutdown, the way /reload does', {}, async (host) => {
      await options.factory(host.pi);
      await host.emit(SHUTDOWN_EVENT, { reason: 'reload' });
      const before = host.tools.length;

      await options.factory(host.pi);

      if (expectedTools.length > 0 && host.tools.length === before) {
        fail('Loading the entry again registered nothing: a module-level latch is surviving the reload.');
      }
      assertContains(
        host.tools.slice(before).map(({ name }) => name),
        expectedTools,
        'the reloaded entry to register tools',
      );
    }),

    // The cockpit and the RPC runtime both load extensions with no TUI. An
    // entry that reaches for one there takes the whole session down.
    scenario('installs and shuts down on a headless host', { hasUI: false, mode: 'rpc' }, async (host) => {
      await options.factory(host.pi);
      await host.emit(START_EVENT, { reason: 'startup' });
      await host.emit(SHUTDOWN_EVENT, { reason: 'quit' });
    }),
  ];
}
