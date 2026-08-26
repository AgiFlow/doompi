import crypto from 'node:crypto';
import type {
  MinorModeActionDescriptor,
  MinorModeArguments,
  MinorModeCatalogService,
  MinorModeRecord,
  MinorModeSessionKind,
} from '@agimon-ai/doompi-extension-contracts/mode';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export const MINOR_MODE_COMMAND = 'minor';
const REQUESTER_SOURCE = '@agimon-ai/doompi/mode-catalog/ui-command';

function sessionKindOf(ctx: ExtensionContext): MinorModeSessionKind {
  return ctx.hasUI && ctx.mode === 'tui' ? 'tui' : 'headless';
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
  ctx: ExtensionContext,
  action: MinorModeActionDescriptor,
): Promise<MinorModeArguments | undefined> {
  const collected: MinorModeArguments = {};
  for (const parameter of action.parameters) {
    if (!parameter.required) continue;
    const title = `${action.label}: ${parameter.label}`;
    if (parameter.kind === 'boolean') {
      collected[parameter.name] = await ctx.ui.confirm(title, parameter.description ?? '');
      continue;
    }
    if (parameter.kind === 'enum') {
      const options = parameter.choices.map((choice) => choice.label);
      const picked = await ctx.ui.select(title, options);
      const choice = picked === undefined ? undefined : parameter.choices[options.indexOf(picked)];
      if (!choice) return undefined;
      collected[parameter.name] = choice.value;
      continue;
    }
    const raw = await ctx.ui.input(title, parameter.description ?? '');
    if (raw === undefined || raw === '') return undefined;
    if (parameter.kind === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        ctx.ui.notify(`${parameter.label} must be a number.`, 'warning');
        return undefined;
      }
      collected[parameter.name] = value;
    } else {
      collected[parameter.name] = raw;
    }
  }
  return collected;
}

/**
 * The /minor command: the web cockpit's road into the minor-mode catalog.
 *
 * The TUI toggles minor modes from the leader menu, which an RPC client cannot
 * reach; a slash command rides the prompt channel every client already has.
 * Bare /minor lists the catalog in a select, /minor <mode> narrows to that
 * mode's opt-ins (a mode may publish several), and /minor <mode> <action>
 * invokes directly. Required action parameters are gathered through the same
 * dialog surface, so every catalog action stays reachable from a browser.
 */
export function registerMinorModeCommand(
  pi: ExtensionAPI,
  currentCatalog: () => MinorModeCatalogService | undefined,
): void {
  pi.registerCommand(MINOR_MODE_COMMAND, {
    description: 'Toggle or drive minor modes',
    getArgumentCompletions: (prefix) => {
      const query = prefix.trim().toLowerCase();
      const records = currentCatalog()?.list() ?? [];
      return records
        .map((record) => record.descriptor.label.toLowerCase())
        .filter((label) => label.startsWith(query))
        .map((label) => ({ value: label, label }));
    },
    handler: async (args, ctx) => {
      const catalog = currentCatalog();
      if (!catalog) {
        ctx.ui.notify('Minor modes are unavailable in this session.', 'warning');
        return;
      }
      const kind = sessionKindOf(ctx);
      const records = catalog.list();
      const [modeQuery, actionQuery] = args.trim().split(/\s+/).filter(Boolean);

      let record: MinorModeRecord | undefined;
      if (modeQuery) {
        record = matchMinorMode(records, modeQuery);
        if (!record) {
          const known = records.map((entry) => entry.descriptor.label.toLowerCase()).join(', ') || 'none';
          ctx.ui.notify(`No minor mode matches "${modeQuery}". Available: ${known}.`, 'warning');
          return;
        }
      } else {
        const listed = records.filter((entry) => actionsFor(entry, kind).length > 0);
        if (listed.length === 0) {
          ctx.ui.notify('No minor modes are available in this session.', 'info');
          return;
        }
        const options = listed.map(
          (entry) => `${isOn(entry) ? '[x]' : '[ ]'} ${entry.descriptor.label}: ${entry.descriptor.description}`,
        );
        const on = listed.filter(isOn).length;
        const picked = await ctx.ui.select(`Minor modes (${String(on)} on)`, options);
        if (picked === undefined) return;
        record = listed[options.indexOf(picked)];
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
        ctx.ui.notify(`${record.descriptor.label} has no actions available in this session.${because}`, 'warning');
        return;
      }

      let action: MinorModeActionDescriptor | undefined;
      if (actionQuery) {
        action = actions.find((entry) => entry.id.toLowerCase() === actionQuery.toLowerCase());
        if (!action) {
          const known = actions.map((entry) => entry.id).join(', ');
          ctx.ui.notify(`No "${actionQuery}" action on ${record.descriptor.label}. Available: ${known}.`, 'warning');
          return;
        }
      } else if (actions.length === 1) {
        action = actions[0];
      } else {
        const options = actions.map((entry) => `${entry.label}: ${entry.description}`);
        const picked = await ctx.ui.select(`${record.descriptor.label} (${record.state.activation})`, options);
        if (picked === undefined) return;
        action = actions[options.indexOf(picked)];
      }
      if (!action) return;

      const argumentsValue = await promptArguments(ctx, action);
      if (argumentsValue === undefined) return;

      try {
        const response = await catalog.invoke(
          {
            operationId: crypto.randomUUID(),
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
        ctx.ui.notify(response.message ?? `${record.descriptor.label} is ${state.activation}${detail}.`, 'info');
      } catch (error) {
        ctx.ui.notify(
          `${record.descriptor.label} ${action.label} failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });
}
