import type {
  MinorModeActionDescriptor,
  MinorModeArguments,
  MinorModeCatalogService,
  MinorModeRecord,
  MinorModeSessionKind,
} from '@agimon-ai/doompi-extension-contracts/mode';

export const MINOR_MODE_COMMAND = 'minor';
export { MINOR_MODE_COMMAND_DESCRIPTION } from '../../constants/commands';
const REQUESTER_SOURCE = '@agimon-ai/doompi/mode-catalog/ui-command';

type NotificationLevel = 'info' | 'warning' | 'error';

export interface MinorModeCommandPrompter {
  select(title: string, options: readonly string[]): Promise<string | undefined>;
  input(title: string, message: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean | undefined>;
  notify(message: string, level: NotificationLevel): void | Promise<void>;
}

function isOn(record: MinorModeRecord): boolean {
  return record.state.activation === 'active' || record.state.activation === 'deactivating';
}

/** A catalog mode addressed the way a person types it: id, label, or id stem. */
export function matchMinorMode(records: readonly MinorModeRecord[], query: string): MinorModeRecord | undefined {
  const needle = query.toLowerCase();
  return records.find(
    (record) =>
      record.descriptor.id.toLowerCase() === needle ||
      record.descriptor.label.toLowerCase() === needle ||
      record.descriptor.id.toLowerCase().split('.')[0] === needle,
  );
}

/** The actions a session of this kind can currently take on a mode. */
export function actionsFor(record: MinorModeRecord, kind: MinorModeSessionKind): MinorModeActionDescriptor[] {
  return record.descriptor.actions.filter((action) => {
    if (!action.contexts.includes(kind)) return false;
    const availability = record.state.actions.find((entry) => entry.id === action.id);
    return availability?.enabled !== false;
  });
}

async function promptArguments(
  ui: MinorModeCommandPrompter,
  action: MinorModeActionDescriptor,
): Promise<MinorModeArguments | undefined> {
  const collected: MinorModeArguments = {};
  for (const parameter of action.parameters) {
    if (!parameter.required) continue;
    const title = `${action.label}: ${parameter.label}`;
    if (parameter.kind === 'boolean') {
      const value = await ui.confirm(title, parameter.description ?? '');
      if (value === undefined) return undefined;
      collected[parameter.name] = value;
      continue;
    }
    if (parameter.kind === 'enum') {
      const options = parameter.choices.map((choice) => choice.label);
      const picked = await ui.select(title, options);
      const choice = picked === undefined ? undefined : parameter.choices[options.indexOf(picked)];
      if (!choice) return undefined;
      collected[parameter.name] = choice.value;
      continue;
    }
    const raw = await ui.input(title, parameter.description ?? '');
    if (raw === undefined || raw === '') return undefined;
    if (parameter.kind === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        await ui.notify(`${parameter.label} must be a number.`, 'warning');
        return undefined;
      }
      collected[parameter.name] = value;
    } else {
      collected[parameter.name] = raw;
    }
  }
  return collected;
}

export interface ExecuteMinorModeCommandOptions {
  catalog: MinorModeCatalogService | undefined;
  kind: MinorModeSessionKind;
  ui: MinorModeCommandPrompter;
}

/** Runs the catalog command against an explicit interaction surface. */
export async function executeMinorModeCommand(args: string, options: ExecuteMinorModeCommandOptions): Promise<void> {
  const { catalog, kind, ui } = options;
  if (!catalog) {
    await ui.notify('Minor modes are unavailable in this session.', 'warning');
    return;
  }

  const records = catalog.list();
  const [modeQuery, actionQuery] = args.trim().split(/\s+/).filter(Boolean);

  let record: MinorModeRecord | undefined;
  if (modeQuery) {
    record = matchMinorMode(records, modeQuery);
    if (!record) {
      const known = records.map((entry) => entry.descriptor.label.toLowerCase()).join(', ') || 'none';
      await ui.notify(`No minor mode matches "${modeQuery}". Available: ${known}.`, 'warning');
      return;
    }
  } else {
    const listed = records.filter((entry) => actionsFor(entry, kind).length > 0);
    if (listed.length === 0) {
      await ui.notify('No minor modes are available in this session.', 'info');
      return;
    }
    const labels = listed.map(
      (entry) => `${isOn(entry) ? '[x]' : '[ ]'} ${entry.descriptor.label}: ${entry.descriptor.description}`,
    );
    const on = listed.filter(isOn).length;
    const picked = await ui.select(`Minor modes (${String(on)} on)`, labels);
    if (picked === undefined) return;
    record = listed[labels.indexOf(picked)];
    if (!record) return;
  }

  const actions = actionsFor(record, kind);
  if (actions.length === 0) {
    // The mode already said why each action is unavailable. Repeating that
    // is the difference between a dead end and an explanation: "requires
    // an interactive session" tells a cockpit user to reach for the TUI,
    // where the bare sentence leaves them guessing.
    const reasons = [
      ...new Set(
        record.state.actions
          .map((entry) => entry.disabledReason)
          .filter((reason): reason is string => reason !== undefined && reason.length > 0),
      ),
    ];
    const because = reasons.length > 0 ? ` ${reasons.join(' ')}` : '';
    await ui.notify(`${record.descriptor.label} has no actions available in this session.${because}`, 'warning');
    return;
  }

  let action: MinorModeActionDescriptor | undefined;
  if (actionQuery) {
    action = actions.find((entry) => entry.id.toLowerCase() === actionQuery.toLowerCase());
    if (!action) {
      const known = actions.map((entry) => entry.id).join(', ');
      await ui.notify(`No "${actionQuery}" action on ${record.descriptor.label}. Available: ${known}.`, 'warning');
      return;
    }
  } else if (actions.length === 1) {
    action = actions[0];
  } else {
    const labels = actions.map((entry) => `${entry.label}: ${entry.description}`);
    const picked = await ui.select(`${record.descriptor.label} (${record.state.activation})`, labels);
    if (picked === undefined) return;
    action = actions[labels.indexOf(picked)];
  }
  if (!action) return;

  const argumentsValue = await promptArguments(ui, action);
  if (argumentsValue === undefined) return;

  try {
    const response = await catalog.invoke(
      {
        operationId: globalThis.crypto.randomUUID(),
        mode: {
          source: record.descriptor.source,
          id: record.descriptor.id,
          ownerGeneration: record.ownerGeneration,
          registrationId: record.registrationId,
        },
        actionId: action.id,
        arguments: argumentsValue,
      },
      REQUESTER_SOURCE,
    );
    const state = response.mode.state;
    const detail = state.detail ? `: ${state.detail}` : '';
    await ui.notify(response.message ?? `${record.descriptor.label} is ${state.activation}${detail}.`, 'info');
  } catch (error) {
    await ui.notify(
      `${record.descriptor.label} ${action.label} failed: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
}
