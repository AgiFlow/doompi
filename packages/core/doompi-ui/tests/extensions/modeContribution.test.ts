import type { MinorModeRecord } from '@agimon-ai/doompi-extension-contracts/mode';
import { describe, expect, it } from 'vitest';
import { projectMinorModeRecords } from '../../src/services/state/uiState.ts';

function record(input: {
  source: string;
  id: string;
  label: string;
  order: number;
  activation: 'inactive' | 'activating' | 'active' | 'deactivating';
  detail?: string;
  color?: 'accent' | 'warning' | 'mdHeading' | 'muted' | 'dim';
}): MinorModeRecord {
  return {
    descriptor: {
      source: input.source,
      id: input.id,
      label: input.label,
      description: `${input.label} mode`,
      order: input.order,
      actions: [],
    },
    state: {
      activation: input.activation,
      condition: 'ready',
      actions: [],
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.color ? { color: input.color } : {}),
    },
    ownerGeneration: `owner-${input.source}`,
    registrationId: `registration-${input.source}`,
    stateRevision: 1,
  };
}

describe('minor-mode catalog projection', () => {
  it('hides inactive availability and renders active and transitional records', () => {
    const projected = projectMinorModeRecords([
      record({ source: 'voice', id: 'voice-auto', label: 'VOICE', order: 30, activation: 'inactive' }),
      record({ source: 'plan', id: 'plan', label: 'PLAN', order: 40, activation: 'active', detail: 'normal' }),
      record({ source: 'loop', id: 'loop', label: 'LOOP', order: 50, activation: 'activating' }),
      record({ source: 'goal', id: 'goal', label: 'GOAL', order: 100, activation: 'deactivating' }),
    ]);

    expect(projected.map(({ label }) => label)).toEqual(['PLAN', 'LOOP', 'GOAL']);
  });

  it('sorts by order, source, and ID while retaining identical IDs from different owners', () => {
    const projected = projectMinorModeRecords([
      record({ source: 'z-owner', id: 'same', label: 'Z', order: 10, activation: 'active' }),
      record({ source: 'a-owner', id: 'z-id', label: 'A Z', order: 10, activation: 'active' }),
      record({ source: 'a-owner', id: 'same', label: 'A SAME', order: 10, activation: 'active' }),
      record({ source: 'first', id: 'first', label: 'FIRST', order: 1, activation: 'active' }),
    ]);

    expect(projected.map(({ source, id }) => `${source}/${id}`)).toEqual([
      'first/first',
      'a-owner/same',
      'a-owner/z-id',
      'z-owner/same',
    ]);
  });

  it('uses the owner-published label, detail, and color', () => {
    expect(
      projectMinorModeRecords([
        record({
          source: 'owner',
          id: 'mode',
          label: 'OWNER LABEL',
          order: 1,
          activation: 'active',
          detail: 'owner detail',
          color: 'warning',
        }),
      ]),
    ).toEqual([
      {
        source: 'owner',
        id: 'mode',
        label: 'OWNER LABEL',
        order: 1,
        detail: 'owner detail',
        color: 'warning',
      },
    ]);
  });
});
