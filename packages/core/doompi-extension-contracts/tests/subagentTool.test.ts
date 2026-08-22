import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  isSubagentAction,
  SUBAGENT_ACTION_FIELDS,
  SUBAGENT_ACTIONS,
  SubagentParams,
  subagentActionAcceptsField,
} from '../src/schemas/subagentTool.ts';

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
