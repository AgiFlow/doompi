import {
  isSubagentAction,
  SUBAGENT_ACTION_FIELDS,
  SUBAGENT_ACTIONS,
  SubagentParams,
  SubagentToolSchema,
  subagentActionAcceptsField,
} from '@agimon-ai/doompi-team/runtime-subagent-tool';
import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

interface VariantSchema {
  additionalProperties?: boolean;
  properties?: Record<string, { const?: string }>;
  required?: string[];
}

function variants(): VariantSchema[] {
  return (SubagentParams as unknown as { anyOf?: VariantSchema[] }).anyOf ?? [];
}

describe('subagent tool contract', () => {
  it('defines strict schema variants whose combined fields match every action', () => {
    const schemas = variants();
    expect(schemas).toHaveLength(Object.keys(SUBAGENT_ACTIONS).length + 1);

    for (const schema of schemas) {
      const action = schema.properties?.action?.const;
      expect(isSubagentAction(action)).toBe(true);
      if (!isSubagentAction(action)) continue;
      const allowedFields = SUBAGENT_ACTION_FIELDS[action] as readonly string[];
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toContain('action');
      expect(Object.keys(schema.properties ?? {}).every((field) => allowedFields.includes(field))).toBe(true);
    }
    for (const action of Object.values(SUBAGENT_ACTIONS)) {
      const fields = new Set(
        schemas
          .filter((schema) => schema.properties?.action?.const === action)
          .flatMap((schema) => Object.keys(schema.properties ?? {})),
      );
      expect([...fields].toSorted()).toEqual([...SUBAGENT_ACTION_FIELDS[action]].toSorted());
    }
  });

  it('reports supported fields without accepting unknown actions', () => {
    expect(subagentActionAcceptsField(SUBAGENT_ACTIONS.run, 'artifacts')).toBe(true);
    expect(subagentActionAcceptsField(SUBAGENT_ACTIONS.agents, 'artifacts')).toBe(false);
    expect(isSubagentAction('restore')).toBe(true);
    expect(isSubagentAction('create')).toBe(false);
  });

  it('rejects the removed wait action', () => {
    expect(isSubagentAction('wait')).toBe(false);
    expect(Check(SubagentParams, { action: 'wait' })).toBe(false);
  });

  it('accepts a one-shot inline agent and rejects malformed profiles', () => {
    expect(
      Check(SubagentParams, {
        action: 'run',
        requests: [
          { agent: 'schema-explorer', inlineAgent: { systemPrompt: 'Inspect schemas only.' }, task: 'Explore' },
        ],
      }),
    ).toBe(true);
    expect(
      Check(SubagentParams, {
        action: 'run',
        requests: [{ agent: 'schema-explorer', inlineAgent: { systemPrompt: '' }, task: 'Explore' }],
      }),
    ).toBe(false);
    expect(
      Check(SubagentParams, {
        action: 'run',
        requests: [
          {
            agent: 'schema-explorer',
            inlineAgent: { systemPrompt: 'Inspect schemas only.', tools: ['write'] },
            task: 'Explore',
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts fleet status or run detail status but rejects transcript lines without an id', () => {
    expect(Check(SubagentParams, { action: 'status' })).toBe(true);
    expect(Check(SubagentParams, { action: 'status', id: 'run-1', transcriptLines: 20 })).toBe(true);
    expect(Check(SubagentParams, { action: 'status', transcriptLines: 20 })).toBe(false);
  });
});

/**
 * How Pi's Anthropic Messages adapter rebuilds a tool's input schema:
 * `{type:'object', properties: schema.properties ?? {}, required: schema.required ?? []}`.
 * A top-level union has neither key, so it reaches the model as an empty object.
 */
function anthropicInputSchema(schema: unknown): {
  properties: Record<string, { enum?: readonly string[] }>;
  required: readonly string[];
} {
  const source = schema as { properties?: Record<string, { enum?: readonly string[] }>; required?: readonly string[] };
  return { properties: source.properties ?? {}, required: source.required ?? [] };
}

describe('declared subagent schema', () => {
  it('still names every action after the Anthropic adapter flattens it', () => {
    const wire = anthropicInputSchema(SubagentToolSchema);
    expect(wire.properties.action?.enum).toEqual([...Object.values(SUBAGENT_ACTIONS)]);
    expect(wire.required).toEqual(['action']);
  });

  it('is why the union cannot be declared directly', () => {
    expect(anthropicInputSchema(SubagentParams).properties).toEqual({});
  });

  it('declares every field some action accepts, and no others', () => {
    const declared = Object.keys(anthropicInputSchema(SubagentToolSchema).properties);
    const accepted = new Set(Object.values(SUBAGENT_ACTION_FIELDS).flat());
    expect(declared.toSorted()).toEqual([...accepted].toSorted());
  });
});