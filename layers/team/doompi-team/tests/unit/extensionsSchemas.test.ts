import { describe, expect, it } from 'vitest';

import { SUBAGENT_ACTIONS, SubagentParams } from '@agimon-ai/doompi-extension-contracts/subagent-tool';

interface VariantSchema {
  additionalProperties?: boolean;
  properties?: Record<string, { const?: string }>;
  required?: string[];
}

function variants(): VariantSchema[] {
  return (SubagentParams as unknown as { anyOf?: VariantSchema[] }).anyOf ?? [];
}

describe('SubagentParams', () => {
  it('defines strict variants for every implemented action and both status forms', () => {
    const schemas = variants();
    expect(schemas).toHaveLength(Object.keys(SUBAGENT_ACTIONS).length + 1);
    expect(
      [...new Set(schemas.map((schema) => schema.properties?.action?.const))].toSorted((left, right) =>
        String(left).localeCompare(String(right)),
      ),
    ).toEqual(Object.values(SUBAGENT_ACTIONS).toSorted((left, right) => left.localeCompare(right)));
    for (const schema of schemas) {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toContain('action');
    }
  });

  it('allows transcriptLines only on the status variant that requires an id', () => {
    const status = variants().filter((schema) => schema.properties?.action?.const === SUBAGENT_ACTIONS.status);

    expect(status).toHaveLength(2);
    expect(status.find((schema) => schema.properties?.transcriptLines)?.required).toContain('id');
    expect(status.find((schema) => !schema.properties?.transcriptLines)?.properties).not.toHaveProperty('id');
  });

  it('uses one canonical run request array and rejects legacy spawn fields', () => {
    const run = variants().find((schema) => schema.properties?.action?.const === SUBAGENT_ACTIONS.run);
    expect(run?.required).toEqual(expect.arrayContaining(['action', 'requests']));
    expect(run?.properties).not.toHaveProperty('agent');
    expect(run?.properties).not.toHaveProperty('tasks');
    expect(run?.properties).not.toHaveProperty('context');
    expect(run?.properties).not.toHaveProperty('runId');
  });

  it('omits wait and other removed management actions', () => {
    const actions = variants().map((schema) => schema.properties?.action?.const);
    for (const removed of ['wait', 'list', 'get', 'doctor', 'interrupt', 'resume']) {
      expect(actions).not.toContain(removed);
    }
  });
});
