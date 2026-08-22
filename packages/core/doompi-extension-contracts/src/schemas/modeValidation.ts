import {
  MINOR_MODE_ERROR_CODE,
  type MinorModeActionDescriptor,
  type MinorModeArguments,
  type MinorModeDescriptor,
  type MinorModeRecord,
  type MinorModeRegistrationRef,
  type MinorModeState,
} from './mode.ts';
import { DoomProtocolError } from './protocol.ts';

export function minorModeKey(identity: Pick<MinorModeDescriptor, 'source' | 'id'>): string {
  return `${identity.source}\u0000${identity.id}`;
}

export function minorModeRegistrationRef(record: MinorModeRecord): MinorModeRegistrationRef {
  return {
    source: record.descriptor.source,
    id: record.descriptor.id,
    ownerGeneration: record.ownerGeneration,
    registrationId: record.registrationId,
  };
}

function duplicateValue(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

export function validateMinorModeDefinition(
  descriptor: MinorModeDescriptor,
  state: MinorModeState,
): string | undefined {
  const duplicateAction = duplicateValue(descriptor.actions.map(({ id }) => id));
  if (duplicateAction) return `Duplicate minor-mode action '${duplicateAction}'.`;
  for (const action of descriptor.actions) {
    const duplicateParameter = duplicateValue(action.parameters.map(({ name }) => name));
    if (duplicateParameter) return `Duplicate parameter '${duplicateParameter}' for action '${action.id}'.`;
    for (const parameter of action.parameters) {
      if (
        parameter.kind === 'string' &&
        parameter.minLength !== undefined &&
        parameter.maxLength !== undefined &&
        parameter.minLength > parameter.maxLength
      ) {
        return `Parameter '${parameter.name}' has minLength greater than maxLength.`;
      }
      if (
        parameter.kind === 'number' &&
        parameter.minimum !== undefined &&
        parameter.maximum !== undefined &&
        parameter.minimum > parameter.maximum
      ) {
        return `Parameter '${parameter.name}' has minimum greater than maximum.`;
      }
      if (parameter.kind === 'enum') {
        const duplicateChoice = duplicateValue(parameter.choices.map(({ value }) => value));
        if (duplicateChoice) return `Parameter '${parameter.name}' has duplicate choice '${duplicateChoice}'.`;
      }
    }
  }
  const duplicateAvailability = duplicateValue(state.actions.map(({ id }) => id));
  if (duplicateAvailability) return `Duplicate action availability '${duplicateAvailability}'.`;
  const descriptors = new Set(descriptor.actions.map(({ id }) => id));
  const available = new Set(state.actions.map(({ id }) => id));
  if (descriptors.size !== available.size || [...descriptors].some((id) => !available.has(id))) {
    return 'Minor-mode state must publish availability for every declared action.';
  }
  return undefined;
}

function invalidArguments(message: string): never {
  throw new DoomProtocolError({ code: MINOR_MODE_ERROR_CODE.invalidArguments, message });
}

export function validateMinorModeActionArguments(
  action: MinorModeActionDescriptor,
  argumentsValue: MinorModeArguments,
): void {
  const parameters = new Map(action.parameters.map((parameter) => [parameter.name, parameter]));
  for (const name of Object.keys(argumentsValue)) {
    if (!parameters.has(name)) invalidArguments(`Unknown argument '${name}' for action '${action.id}'.`);
  }
  for (const parameter of action.parameters) {
    const value = argumentsValue[parameter.name];
    if (value === undefined) {
      if (parameter.required) invalidArguments(`Missing required argument '${parameter.name}'.`);
      continue;
    }
    if (parameter.kind === 'string') {
      if (typeof value !== 'string') invalidArguments(`Argument '${parameter.name}' must be a string.`);
      if (parameter.minLength !== undefined && value.length < parameter.minLength) {
        invalidArguments(`Argument '${parameter.name}' is shorter than ${parameter.minLength}.`);
      }
      if (parameter.maxLength !== undefined && value.length > parameter.maxLength) {
        invalidArguments(`Argument '${parameter.name}' is longer than ${parameter.maxLength}.`);
      }
      continue;
    }
    if (parameter.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        invalidArguments(`Argument '${parameter.name}' must be a finite number.`);
      }
      if (parameter.integer && !Number.isInteger(value)) {
        invalidArguments(`Argument '${parameter.name}' must be an integer.`);
      }
      if (parameter.minimum !== undefined && value < parameter.minimum) {
        invalidArguments(`Argument '${parameter.name}' must be at least ${parameter.minimum}.`);
      }
      if (parameter.maximum !== undefined && value > parameter.maximum) {
        invalidArguments(`Argument '${parameter.name}' must be at most ${parameter.maximum}.`);
      }
      continue;
    }
    if (parameter.kind === 'boolean') {
      if (typeof value !== 'boolean') invalidArguments(`Argument '${parameter.name}' must be a boolean.`);
      continue;
    }
    if (typeof value !== 'string' || !parameter.choices.some((choice) => choice.value === value)) {
      invalidArguments(`Argument '${parameter.name}' must be one of the declared choices.`);
    }
  }
}
