import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-core/help';
import { createPiHelpToolGate } from '@agimon-ai/doompi-core/help';
import { createDoomToolSurface, DOOM_TOOL_SURFACE_SERVICE } from '@agimon-ai/doompi-core/toolSurface';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';

describe('package-owned Pi Help tools', () => {
  it('fails closed without providers, follows late Help and replacement, and respects other restrictions', async () => {
    const root = new Context();
    const gate = createPiHelpToolGate('@fixture/diagnostics', ['diagnostic']);
    let active = ['read', 'diagnostic'];
    const surface = createDoomToolSurface({
      generation: 'tools',
      allTools: () => ['read', 'diagnostic'],
      activeTools: () => active,
      setActiveTools: (names) => {
        active = names;
      },
    });
    try {
      await root.plugin(gate.services[0]!).await();
      expect(() => gate.assertActive('diagnostic')).toThrow('inactive');
      await root
        .plugin((child) => {
          child.provide(DOOM_TOOL_SURFACE_SERVICE, surface);
        })
        .await();
      gate.onStart();
      expect(active).toEqual(['read']);
      const help = createDoomHelpService('first');
      const provider = root.plugin((child) => {
        child.provide(DOOM_HELP_SERVICE, help);
      });
      await provider.await();
      help.publish({ activation: 'active', skills: [], diagnostics: [] });
      expect(active).toEqual(['read', 'diagnostic']);
      const signal = gate.assertActive('diagnostic');
      expect(surface.inspect()).toEqual([
        {
          source: '@fixture/diagnostics',
          name: 'diagnostic',
          active: true,
          attribution: { kind: 'minor', mode: 'help' },
        },
      ]);
      const restriction = surface.register({
        source: 'permissions',
        restrict: (names) => names.filter((name) => name !== 'diagnostic'),
      });
      expect(() => gate.assertActive('diagnostic')).toThrow('restricted');
      restriction.dispose();
      expect(gate.assertActive('diagnostic').aborted).toBe(false);
      expect(() => gate.assertActive('other')).toThrow();
      const cancelled = new AbortController();
      cancelled.abort(new Error('cancelled'));
      expect(() => gate.assertActive('diagnostic', cancelled.signal)).toThrow('cancelled');
      await provider.dispose();
      expect(signal.aborted).toBe(true);
      expect(active).toEqual(['read']);
      expect(() => gate.assertActive('diagnostic')).toThrow('inactive');
      const next = createDoomHelpService('replacement');
      await root
        .plugin((child) => {
          child.provide(DOOM_HELP_SERVICE, next);
        })
        .await();
      expect(active).toEqual(['read']);
      next.publish({ activation: 'degraded', skills: [], diagnostics: [] });
      expect(active).toEqual(['read', 'diagnostic']);
      next.publish({ activation: 'inactive', skills: [], diagnostics: [] });
      expect(active).toEqual(['read']);
      next.dispose();
      help.dispose();
    } finally {
      await root.fiber.dispose();
      surface.dispose();
    }
    expect(() => gate.assertActive('diagnostic')).toThrow();
  });
});
