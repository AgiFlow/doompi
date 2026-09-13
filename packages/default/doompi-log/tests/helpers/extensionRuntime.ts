import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createPiTelemetryRuntime } from '../../src/controllers/piTelemetry';
import { createLogViewRuntime } from '../../src/tui/logRuntime';
import type { PiTelemetryExtensionOptions } from '../../src/types/piTelemetry';

function installTestRuntime(pi: ExtensionAPI, options: PiTelemetryExtensionOptions, withView: boolean): Context {
  const cordis = new Context();
  const view = withView ? createLogViewRuntime((ctx) => runtime.waitForSession(ctx), options) : undefined;
  const runtime = createPiTelemetryRuntime(cordis, view?.telemetryOptions ?? options);
  for (const [event, handler] of Object.entries(runtime.events)) Reflect.apply(pi.on, pi, [event, handler]);
  for (const [name, command] of view?.commands ?? []) pi.registerCommand(name, command);
  for (const service of view?.services ?? []) cordis.plugin(service);
  cordis.effect(() => async () => {
    view?.onDispose();
    await runtime.onDispose();
  });
  let shutdown: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    (event, context) =>
      (shutdown ??= (async () => {
        await runtime.finishSession(event.reason, context);
        await cordis.fiber.dispose();
      })()),
  );
  return cordis;
}

export function installTelemetryTestRuntime(pi: ExtensionAPI, options: PiTelemetryExtensionOptions = {}): Context {
  return installTestRuntime(pi, options, false);
}
export function installLogTestRuntime(pi: ExtensionAPI, options: PiTelemetryExtensionOptions = {}): Context {
  return installTestRuntime(pi, options, true);
}
