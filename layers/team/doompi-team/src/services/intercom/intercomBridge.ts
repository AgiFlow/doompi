/**
 * Whether a child would be wired to talk back to the session that spawned it,
 * reported for diagnostics.
 *
 * WHY THIS IS ONLY A DIAGNOSTIC NOW:
 * Children receive the native intercom runtime directly. This module retains
 * only the human-facing doctor diagnostic and does not register or alias tools.
 *
 * AVOID:
 * - Re-adding a resolution path here without a caller. If the bridge needs to
 *   shape an agent again, wire it in the same change
 */

export const NATIVE_INTERCOM_EXTENSION_DIR = 'native:doom-team-intercom';

export type IntercomBridgeMode = 'off' | 'always' | 'fork-only';

/** The intercom-bridge slice of this package's extension config. Narrow on purpose. */
export interface IntercomBridgeConfigInput {
  mode?: unknown;
  instructionFile?: unknown;
  resultDelivery?: unknown;
}

interface ResolvedIntercomBridgeConfig {
  mode: IntercomBridgeMode;
  resultDelivery: boolean;
}

export interface IntercomBridgeDiagnostic {
  active: boolean;
  mode: IntercomBridgeMode;
  wantsIntercom: boolean;
  intercomAvailable: boolean;
  extensionDir: string;
  orchestratorTarget?: string;
  reason?: string;
}

interface ResolveIntercomBridgeInput {
  config: IntercomBridgeConfigInput | undefined;
  context: 'fresh' | 'fork' | undefined;
  orchestratorTarget?: string;
}

export function resolveIntercomBridgeMode(value: unknown): IntercomBridgeMode {
  if (value === 'off' || value === 'always' || value === 'fork-only') return value;
  return 'always';
}

function resolveIntercomBridgeConfig(value: IntercomBridgeConfigInput | undefined): ResolvedIntercomBridgeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { mode: 'always', resultDelivery: true };
  }
  return { mode: resolveIntercomBridgeMode(value.mode), resultDelivery: value.resultDelivery !== false };
}

/** Why the bridge is not active, or `undefined` when it is. */
function inactiveReason(
  mode: IntercomBridgeMode,
  context: 'fresh' | 'fork' | undefined,
  orchestratorTarget: string | undefined,
): string | undefined {
  if (mode === 'off') return 'bridge mode is off';
  if (mode === 'fork-only' && context !== 'fork') return 'bridge mode is fork-only and context is not fork';
  if (!orchestratorTarget) return 'orchestrator target is not available';
  return undefined;
}

/**
 * Report the bridge's state without changing anything.
 *
 * `wantsIntercom` and `active` differ deliberately: the first says the
 * configuration asks for a bridge, the second says one is actually available.
 * A doctor report needs to distinguish "you turned it off" from "it is on but
 * has no orchestrator to reach".
 */
export function diagnoseIntercomBridge(input: ResolveIntercomBridgeInput): IntercomBridgeDiagnostic {
  const { mode } = resolveIntercomBridgeConfig(input.config);
  const orchestratorTarget = input.orchestratorTarget?.trim();
  const wantsIntercom = mode !== 'off' && !(mode === 'fork-only' && input.context !== 'fork');
  const reason = inactiveReason(mode, input.context, orchestratorTarget);
  return {
    active: reason === undefined,
    mode,
    wantsIntercom,
    intercomAvailable: true,
    extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
    ...(orchestratorTarget ? { orchestratorTarget } : {}),
    ...(reason ? { reason } : {}),
  };
}
