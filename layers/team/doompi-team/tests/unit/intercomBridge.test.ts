import { describe, expect, it } from 'vitest';
import {
  NATIVE_INTERCOM_EXTENSION_DIR,
  diagnoseIntercomBridge,
  resolveIntercomBridgeMode,
  type IntercomBridgeConfigInput,
} from '../../src/services/intercomBridge';

describe('intercom bridge diagnostics', () => {
  it.each(['off', 'always', 'fork-only'] as const)('accepts %s as an explicit mode', (mode) => {
    expect(resolveIntercomBridgeMode(mode)).toBe(mode);
  });

  it('defaults invalid or missing configuration to always', () => {
    expect(resolveIntercomBridgeMode('unexpected')).toBe('always');
    expect(resolveIntercomBridgeMode(undefined)).toBe('always');
    for (const config of [undefined, null, []]) {
      expect(
        diagnoseIntercomBridge({
          config: config as IntercomBridgeConfigInput | undefined,
          context: 'fresh',
          orchestratorTarget: 'parent',
        }),
      ).toMatchObject({
        active: true,
        mode: 'always',
        wantsIntercom: true,
        extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
      });
    }
  });

  it('reports an explicitly disabled bridge even when the parent is available', () => {
    expect(
      diagnoseIntercomBridge({
        config: { mode: 'off' },
        context: 'fork',
        orchestratorTarget: 'parent',
      }),
    ).toEqual({
      active: false,
      mode: 'off',
      wantsIntercom: false,
      intercomAvailable: true,
      extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
      orchestratorTarget: 'parent',
      reason: 'bridge mode is off',
    });
  });

  it('activates fork-only mode only for a fork with an orchestrator target', () => {
    for (const context of ['fresh', undefined] as const) {
      expect(
        diagnoseIntercomBridge({ config: { mode: 'fork-only' }, context, orchestratorTarget: 'parent' }),
      ).toMatchObject({
        active: false,
        wantsIntercom: false,
        reason: 'bridge mode is fork-only and context is not fork',
      });
    }
    expect(
      diagnoseIntercomBridge({ config: { mode: 'fork-only' }, context: 'fork', orchestratorTarget: 'parent' }),
    ).toMatchObject({
      active: true,
      wantsIntercom: true,
      orchestratorTarget: 'parent',
    });
  });

  it('trims a target and distinguishes missing transport from disabled configuration', () => {
    expect(
      diagnoseIntercomBridge({
        config: { mode: 'always', resultDelivery: false },
        context: 'fresh',
        orchestratorTarget: '  ',
      }),
    ).toEqual({
      active: false,
      mode: 'always',
      wantsIntercom: true,
      intercomAvailable: true,
      extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
      reason: 'orchestrator target is not available',
    });
    expect(diagnoseIntercomBridge({ config: {}, context: 'fresh', orchestratorTarget: ' parent ' })).toMatchObject({
      active: true,
      orchestratorTarget: 'parent',
    });
  });
});
