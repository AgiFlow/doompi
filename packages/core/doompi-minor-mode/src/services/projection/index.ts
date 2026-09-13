import { DOOM_MINOR_MODE_ENTRY_TYPE } from '../../schemas/mode';
import type {
  MinorModeCatalogSnapshot,
  MinorModeProjection,
  MinorModeRecordProjection,
  MinorModeSessionKind,
} from '../../schemas/mode';

/**
 * The catalog as a client should see it: one entry per mode, sorted the way
 * the leader menu sorts, with only the actions this session kind can take and
 * none of the registration bookkeeping a client has no use for.
 */
export function projectMinorModes(snapshot: MinorModeCatalogSnapshot, kind: MinorModeSessionKind): MinorModeProjection {
  const modes: MinorModeRecordProjection[] = snapshot.modes
    .map((record) => ({
      id: record.descriptor.id,
      label: record.descriptor.label,
      description: record.descriptor.description,
      order: record.descriptor.order,
      activation: record.state.activation,
      condition: record.state.condition,
      ...(record.state.detail ? { detail: record.state.detail } : {}),
      actions: record.descriptor.actions
        .filter((action) => action.contexts.includes(kind))
        .map((action) => {
          const availability = record.state.actions.find((entry) => entry.id === action.id);
          return {
            id: action.id,
            label: action.label,
            description: action.description,
            enabled: availability?.enabled !== false,
            ...(availability?.disabledReason ? { disabledReason: availability.disabledReason } : {}),
            needsInput: action.parameters.some((parameter) => parameter.required),
          };
        }),
    }))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  return { version: 1, revision: snapshot.revision, modes };
}

/** Reads the latest valid persisted activation set; absence preserves caller defaults. */
export function restoreMinorModeSelection(entries: readonly unknown[]): string[] | undefined {
  for (const entry of [...entries].reverse()) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('customType' in entry) ||
      entry.customType !== DOOM_MINOR_MODE_ENTRY_TYPE ||
      !('data' in entry)
    )
      continue;
    const data = entry.data;
    if (!data || typeof data !== 'object' || !('modes' in data) || !Array.isArray(data.modes)) continue;
    return [
      ...new Set(
        data.modes
          .filter(
            (mode) => mode && typeof mode === 'object' && mode.activation === 'active' && typeof mode.id === 'string',
          )
          .map((mode) => mode.id as string),
      ),
    ];
  }
  return undefined;
}
