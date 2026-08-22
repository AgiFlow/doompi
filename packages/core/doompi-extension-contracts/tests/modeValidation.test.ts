import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  MINOR_MODE_ERROR_CODE,
  type MinorModeActionDescriptor,
  type MinorModeDescriptor,
  type MinorModeState,
  MinorModeStateSchema,
} from '../src/schemas/mode.ts';
import { validateMinorModeActionArguments, validateMinorModeDefinition } from '../src/schemas/modeValidation.ts';

const action: MinorModeActionDescriptor = {
  id: 'configure',
  label: 'Configure',
  description: 'Configure a mode.',
  contexts: ['headless'],
  parameters: [
    { name: 'text', label: 'Text', kind: 'string', required: true, minLength: 2, maxLength: 4 },
    { name: 'count', label: 'Count', kind: 'number', required: true, integer: true, minimum: 1, maximum: 3 },
    { name: 'enabled', label: 'Enabled', kind: 'boolean', required: true },
    {
      name: 'flavor',
      label: 'Flavor',
      kind: 'enum',
      required: true,
      choices: [
        { value: 'normal', label: 'Normal' },
        { value: 'debug', label: 'Debug' },
      ],
    },
    { name: 'optional', label: 'Optional', kind: 'string', required: false },
  ],
};

const descriptor: MinorModeDescriptor = {
  source: '@agimon-ai/validation-mode',
  id: 'validation',
  label: 'VALIDATION',
  description: 'Validation fixture.',
  order: 1,
  actions: [action],
};

const state: MinorModeState = {
  activation: 'inactive',
  condition: 'ready',
  actions: [{ id: action.id, enabled: true }],
};

function invalid(argumentsValue: Record<string, string | number | boolean>, message: string): void {
  expect(() => validateMinorModeActionArguments(action, argumentsValue)).toThrowError(
    expect.objectContaining({ code: MINOR_MODE_ERROR_CODE.invalidArguments, message }),
  );
}

describe('minor-mode state schema', () => {
  it('accepts an optional bounded model context variant', () => {
    expect(Check(MinorModeStateSchema, { ...state, modelContextVariant: 'stable-variant' })).toBe(true);
    expect(Check(MinorModeStateSchema, state)).toBe(true);
    expect(Check(MinorModeStateSchema, { ...state, modelContextVariant: '' })).toBe(false);
    expect(Check(MinorModeStateSchema, { ...state, modelContextVariant: 'x'.repeat(129) })).toBe(false);
  });
});

describe('minor-mode definition validation', () => {
  it('rejects duplicate and inconsistent descriptors', () => {
    expect(validateMinorModeDefinition(descriptor, state)).toBeUndefined();
    expect(
      validateMinorModeDefinition(
        { ...descriptor, actions: [{ ...action, parameters: [action.parameters[0], action.parameters[0]] }] },
        state,
      ),
    ).toContain("Duplicate parameter 'text'");
    expect(
      validateMinorModeDefinition(
        {
          ...descriptor,
          actions: [
            {
              ...action,
              parameters: [{ name: 'text', label: 'Text', kind: 'string', required: true, minLength: 5, maxLength: 2 }],
            },
          ],
        },
        state,
      ),
    ).toContain('minLength greater than maxLength');
    expect(
      validateMinorModeDefinition(
        {
          ...descriptor,
          actions: [
            {
              ...action,
              parameters: [{ name: 'count', label: 'Count', kind: 'number', required: true, minimum: 5, maximum: 2 }],
            },
          ],
        },
        state,
      ),
    ).toContain('minimum greater than maximum');
    expect(
      validateMinorModeDefinition(
        {
          ...descriptor,
          actions: [
            {
              ...action,
              parameters: [
                {
                  name: 'flavor',
                  label: 'Flavor',
                  kind: 'enum',
                  required: true,
                  choices: [
                    { value: 'same', label: 'First' },
                    { value: 'same', label: 'Second' },
                  ],
                },
              ],
            },
          ],
        },
        state,
      ),
    ).toContain("duplicate choice 'same'");
  });

  it('requires exactly one availability entry for every action', () => {
    expect(
      validateMinorModeDefinition(descriptor, {
        ...state,
        actions: [state.actions[0], state.actions[0]],
      }),
    ).toContain("Duplicate action availability 'configure'");
    expect(validateMinorModeDefinition(descriptor, { ...state, actions: [] })).toContain(
      'must publish availability for every declared action',
    );
    expect(
      validateMinorModeDefinition(descriptor, {
        ...state,
        actions: [{ id: 'unknown', enabled: true }],
      }),
    ).toContain('must publish availability for every declared action');
  });
});

describe('minor-mode argument validation', () => {
  it('accepts every bounded scalar kind and absent optional values', () => {
    expect(() =>
      validateMinorModeActionArguments(action, {
        text: 'okay',
        count: 2,
        enabled: true,
        flavor: 'debug',
      }),
    ).not.toThrow();
  });

  it('rejects string type and length violations', () => {
    invalid({ text: true, count: 2, enabled: true, flavor: 'normal' }, "Argument 'text' must be a string.");
    invalid({ text: 'x', count: 2, enabled: true, flavor: 'normal' }, "Argument 'text' is shorter than 2.");
    invalid({ text: 'abcde', count: 2, enabled: true, flavor: 'normal' }, "Argument 'text' is longer than 4.");
  });

  it('rejects numeric type, finite, integer, and range violations', () => {
    invalid({ text: 'ok', count: '2', enabled: true, flavor: 'normal' }, "Argument 'count' must be a finite number.");
    invalid(
      { text: 'ok', count: Number.NaN, enabled: true, flavor: 'normal' },
      "Argument 'count' must be a finite number.",
    );
    invalid({ text: 'ok', count: 1.5, enabled: true, flavor: 'normal' }, "Argument 'count' must be an integer.");
    invalid({ text: 'ok', count: 0, enabled: true, flavor: 'normal' }, "Argument 'count' must be at least 1.");
    invalid({ text: 'ok', count: 4, enabled: true, flavor: 'normal' }, "Argument 'count' must be at most 3.");
  });

  it('rejects boolean and enum violations', () => {
    invalid({ text: 'ok', count: 2, enabled: 'yes', flavor: 'normal' }, "Argument 'enabled' must be a boolean.");
    invalid(
      { text: 'ok', count: 2, enabled: true, flavor: true },
      "Argument 'flavor' must be one of the declared choices.",
    );
    invalid(
      { text: 'ok', count: 2, enabled: true, flavor: 'other' },
      "Argument 'flavor' must be one of the declared choices.",
    );
  });

  it('rejects missing required and unknown arguments', () => {
    invalid({ text: 'ok', count: 2, enabled: true }, "Missing required argument 'flavor'.");
    invalid(
      { text: 'ok', count: 2, enabled: true, flavor: 'normal', extra: true },
      "Unknown argument 'extra' for action 'configure'.",
    );
  });
});
