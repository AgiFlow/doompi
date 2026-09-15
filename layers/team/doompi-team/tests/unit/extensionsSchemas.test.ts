import { describe, expect, it } from 'vitest';

import {
  SUBAGENT_ACTION_FIELDS,
  SUBAGENT_ACTIONS,
  SubagentParams,
  SubagentToolSchema,
} from '../../src/exports/subagentTool';

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

/**
 * How Pi's Anthropic Messages adapter rebuilds a tool's input schema:
 * `{type:'object', properties: schema.properties ?? {}, required: schema.required ?? []}`.
 * A top-level union has neither key, so it reached the model as an empty object
 * while the host went on validating calls against the union.
 */
function anthropicInputSchema(schema: unknown): {
  properties: Record<string, { enum?: readonly string[] }>;
  required: readonly string[];
} {
  const source = schema as { properties?: Record<string, { enum?: readonly string[] }>; required?: readonly string[] };
  return { properties: source.properties ?? {}, required: source.required ?? [] };
}

describe('SubagentToolSchema', () => {
  it('still names every action after the Anthropic adapter flattens it', () => {
    const wire = anthropicInputSchema(SubagentToolSchema);
    expect(wire.properties.action?.enum).toEqual(Object.values(SUBAGENT_ACTIONS));
    expect(wire.required).toEqual(['action']);
  });

  it('is why the union cannot be declared to the model directly', () => {
    expect(anthropicInputSchema(SubagentParams).properties).toEqual({});
  });

  it('declares every field some action accepts, and no others', () => {
    const declared = Object.keys(anthropicInputSchema(SubagentToolSchema).properties);
    const accepted = new Set(Object.values(SUBAGENT_ACTION_FIELDS).flat());
    expect(declared.toSorted()).toEqual([...accepted].toSorted());
  });
});
