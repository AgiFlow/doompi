import type { MinorModeCatalogSnapshot } from '@agimon-ai/doompi-extension-contracts/mode';
import { describe, expect, it } from 'vitest';
import { projectMinorModes } from '../../src/services/minorModeProjection.ts';

const SNAPSHOT: MinorModeCatalogSnapshot = {
  hostGeneration: 'host-1',
  revision: 7,
  modes: [
    {
      descriptor: {
        source: '@agimon-ai/plan',
        id: 'plan',
        label: 'Plan',
        description: 'Read-only planning.',
        order: 20,
        actions: [
          {
            id: 'activate',
            label: 'Activate',
            description: 'On.',
            contexts: ['tui', 'headless'],
            parameters: [{ name: 'flavor', label: 'Flavor', kind: 'string', required: true }],
          },
          { id: 'menu', label: 'Menu', description: 'TUI only.', contexts: ['tui'], parameters: [] },
        ],
      },
      state: { activation: 'active', condition: 'ready', detail: 'fable', actions: [] },
      ownerGeneration: 'g',
      registrationId: 'r',
      stateRevision: 3,
    },
    {
      descriptor: {
        source: '@agimon-ai/help',
        id: 'help',
        label: 'Help',
        description: 'Package help.',
        order: 10,
        actions: [{ id: 'toggle', label: 'Toggle', description: 'Flip.', contexts: ['headless'], parameters: [] }],
      },
      state: {
        activation: 'inactive',
        condition: 'ready',
        actions: [{ id: 'toggle', enabled: false, disabledReason: 'busy' }],
      },
      ownerGeneration: 'g',
      registrationId: 'r2',
      stateRevision: 1,
    },
  ],
};

describe('projectMinorModes', () => {
  it('keeps only what a client renders, in leader order, with session-kind actions', () => {
    const projection = projectMinorModes(SNAPSHOT, 'headless');
    expect(projection).toEqual({
      version: 1,
      revision: 7,
      modes: [
        {
          id: 'help',
          label: 'Help',
          description: 'Package help.',
          order: 10,
          activation: 'inactive',
          condition: 'ready',
          actions: [
            {
              id: 'toggle',
              label: 'Toggle',
              description: 'Flip.',
              enabled: false,
              disabledReason: 'busy',
              needsInput: false,
            },
          ],
        },
        {
          id: 'plan',
          label: 'Plan',
          description: 'Read-only planning.',
          order: 20,
          activation: 'active',
          condition: 'ready',
          detail: 'fable',
          actions: [{ id: 'activate', label: 'Activate', description: 'On.', enabled: true, needsInput: true }],
        },
      ],
    });
  });

  it('includes tui-only actions for a tui session', () => {
    const plan = projectMinorModes(SNAPSHOT, 'tui').modes.find((mode) => mode.id === 'plan');
    expect(plan?.actions.map((action) => action.id)).toEqual(['activate', 'menu']);
  });
});
