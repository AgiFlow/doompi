import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  installDoomLogRuntime,
  installPiTelemetryRuntime,
  type PiTelemetryExtensionOptions,
  type PiTelemetryRuntimeHandle,
} from '../../src/adapters/pi/extension.ts';

function installTestRuntime(pi: ExtensionAPI, install: (cordis: Context) => PiTelemetryRuntimeHandle): Context {
  const cordis = new Context();
  const runtime = install(cordis);
  let shutdown: Promise<void> | undefined;
  pi.on('session_shutdown', (event, context) => {
    shutdown ??= (async () => {
      await runtime.finishSession(event.reason, context);
      await cordis.fiber.dispose();
    })();
    return shutdown;
  });
  return cordis;
}

export function installTelemetryTestRuntime(pi: ExtensionAPI, options: PiTelemetryExtensionOptions = {}): Context {
  return installTestRuntime(pi, (cordis) => installPiTelemetryRuntime(cordis, pi, options));
}

export function installLogTestRuntime(pi: ExtensionAPI, options: PiTelemetryExtensionOptions = {}): Context {
  return installTestRuntime(pi, (cordis) => installDoomLogRuntime(cordis, pi, options));
}
