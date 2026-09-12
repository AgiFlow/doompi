type AppKeybinding =
  | 'app.model.select'
  | 'app.model.cycleForward'
  | 'app.thinking.cycle'
  | 'app.session.new'
  | 'app.session.resume'
  | 'app.session.tree'
  | 'app.session.fork'
  | 'app.editor.external'
  | 'app.exit';

import type {
  LeaderBinding as DoomLeaderBinding,
  LeaderCommand as DoomLeaderCommand,
  LeaderContribution as DoomLeaderContribution,
  LeaderAction as DoomLeaderExtensionAction,
  LeaderSegment as DoomLeaderSegment,
  LeaderTone as DoomLeaderTone,
} from '@agimon-ai/doompi-extension-contracts/leader';

interface AppLeaderAction {
  type: 'app';
  action: AppKeybinding;
}

interface CommandLeaderAction {
  type: 'command';
  command: DoomLeaderCommand;
}

interface ExtensionLeaderAction {
  type: 'extension';
  source: string;
  action: DoomLeaderExtensionAction;
}

export type DoomLeaderAction = AppLeaderAction | CommandLeaderAction | ExtensionLeaderAction;

export interface DoomLeaderResolvedOption {
  key: string;
  label: string;
  detail?: string;
  tone?: DoomLeaderTone;
  hasChildren: boolean;
  action?: DoomLeaderAction;
}

export interface DoomLeaderGroup {
  label: string;
  options: readonly DoomLeaderResolvedOption[];
}

export interface DoomLeaderDiagnostic {
  source: string;
  bindingId?: string;
  message: string;
}

export interface DoomLeaderRegistrationResult {
  accepted: boolean;
  diagnostics: readonly DoomLeaderDiagnostic[];
}

interface InternalLeaderBinding {
  id: string;
  source: string;
  path: readonly [DoomLeaderSegment, ...DoomLeaderSegment[]];
  action: DoomLeaderAction;
}

interface LeaderNode {
  key: string;
  label: string;
  detail?: string;
  tone?: DoomLeaderTone;
  order: number;
  owner: string;
  bindingId?: string;
  children: Map<string, LeaderNode>;
  action?: DoomLeaderAction;
}

interface ParsedContribution {
  contribution?: DoomLeaderContribution;
  diagnostics: DoomLeaderDiagnostic[];
}

const CORE_SOURCE = '@agimon-ai/doompi-ui';
const UNKNOWN_SOURCE = 'unknown';
const ROOT_LABEL = 'leader';
const DEFAULT_OPTION_ORDER = 500;
const MAX_OPTION_ORDER = 1000;
const MAX_PATH_LENGTH = 4;
const MAX_SOURCE_LENGTH = 128;
const MAX_BINDING_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 32;
const MAX_DETAIL_LENGTH = 80;
const MAX_COMMAND_NAME_LENGTH = 64;
const MAX_COMMAND_ARGUMENT_LENGTH = 256;
const MAX_ACTION_NAME_LENGTH = 128;
const SAFE_KEY = /^[a-z0-9]$/;
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]*$/;
const SAFE_SOURCE = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/;
const SAFE_COMMAND_NAME = /^[a-z0-9][a-z0-9:_-]*$/;
const C0_CONTROL_MAX = 31;
const DELETE_CHARACTER = 127;
const MODEL_GROUP = { key: 'm', label: 'models', detail: 'model and thinking level', order: 10 } as const;
const SESSION_GROUP = { key: 's', label: 'sessions', detail: 'history, forks and branches', order: 30 } as const;
const EXTENSION_GROUP = { key: 'e', label: 'extension', detail: 'tools, skills and config', order: 50 } as const;
const HELP_GROUP = { key: 'h', label: 'help', detail: 'package docs and logs', order: 70 } as const;
const QUIT_GROUP = { key: 'q', label: 'quit', detail: 'leave the session', order: 90 } as const;

function coreBinding(
  id: string,
  path: readonly [DoomLeaderSegment, ...DoomLeaderSegment[]],
  action: DoomLeaderAction,
): InternalLeaderBinding {
  return { id, source: CORE_SOURCE, path, action };
}

const CORE_BINDINGS: readonly InternalLeaderBinding[] = [
  coreBinding('model.select', [MODEL_GROUP, { key: 'm', label: 'select', detail: 'choose model', order: 10 }], {
    type: 'app',
    action: 'app.model.select',
  }),
  coreBinding('model.next', [MODEL_GROUP, { key: 'n', label: 'next', detail: 'cycle model', order: 20 }], {
    type: 'app',
    action: 'app.model.cycleForward',
  }),
  coreBinding('thinking.cycle', [MODEL_GROUP, { key: 't', label: 'thinking', detail: 'cycle level', order: 30 }], {
    type: 'app',
    action: 'app.thinking.cycle',
  }),
  coreBinding('tools.open', [EXTENSION_GROUP, { key: 't', label: 'tools', detail: 'browse tools', order: 20 }], {
    type: 'command',
    command: { name: 'tools' },
  }),
  // Core rather than contributed, so no extension owns the key and the panel is
  // reachable even when nothing has contributed a section to it yet.
  coreBinding('config.open', [EXTENSION_GROUP, { key: 'c', label: 'config', detail: 'settings', order: 30 }], {
    type: 'command',
    command: { name: 'config' },
  }),
  coreBinding('session.new', [SESSION_GROUP, { key: 'n', label: 'new', detail: 'fresh session', order: 10 }], {
    type: 'app',
    action: 'app.session.new',
  }),
  coreBinding('session.resume', [SESSION_GROUP, { key: 'r', label: 'resume', detail: 'open history', order: 20 }], {
    type: 'app',
    action: 'app.session.resume',
  }),
  coreBinding('session.tree', [SESSION_GROUP, { key: 't', label: 'tree', detail: 'branch view', order: 30 }], {
    type: 'app',
    action: 'app.session.tree',
  }),
  coreBinding('session.fork', [SESSION_GROUP, { key: 'f', label: 'fork', detail: 'from selection', order: 40 }], {
    type: 'app',
    action: 'app.session.fork',
  }),
  coreBinding('help.hotkeys', [HELP_GROUP, { key: 'h', label: 'hotkeys', detail: 'show bindings' }], {
    type: 'command',
    command: { name: 'hotkeys' },
  }),
  coreBinding('app.exit', [QUIT_GROUP, { key: 'q', label: 'quit', detail: 'exit Pi' }], {
    type: 'app',
    action: 'app.exit',
  }),
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(source: string, message: string, bindingId?: string): DoomLeaderDiagnostic {
  return { source, message, ...(bindingId ? { bindingId } : {}) };
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= C0_CONTROL_MAX || codeUnit === DELETE_CHARACTER) return true;
  }
  return false;
}

function readRequiredText(
  value: unknown,
  field: string,
  maximumLength: number,
  source: string,
  diagnostics: DoomLeaderDiagnostic[],
  bindingId?: string,
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    diagnostics.push(diagnostic(source, `${field} must be a non-empty string.`, bindingId));
    return undefined;
  }
  const text = value.trim();
  if (text.length > maximumLength || containsControlCharacter(text)) {
    diagnostics.push(
      diagnostic(
        source,
        `${field} must be at most ${maximumLength} characters and contain no control characters.`,
        bindingId,
      ),
    );
    return undefined;
  }
  return text;
}

function readOptionalText(
  value: unknown,
  field: string,
  maximumLength: number,
  source: string,
  diagnostics: DoomLeaderDiagnostic[],
  bindingId: string,
): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredText(value, field, maximumLength, source, diagnostics, bindingId);
}

function parseSegment(
  value: unknown,
  source: string,
  bindingId: string,
  index: number,
  diagnostics: DoomLeaderDiagnostic[],
): DoomLeaderSegment | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(source, `bindings[].path[${index}] must be an object.`, bindingId));
    return undefined;
  }

  const key = readRequiredText(value.key, `bindings[].path[${index}].key`, 1, source, diagnostics, bindingId);
  const label = readRequiredText(
    value.label,
    `bindings[].path[${index}].label`,
    MAX_LABEL_LENGTH,
    source,
    diagnostics,
    bindingId,
  );
  const detail = readOptionalText(
    value.detail,
    `bindings[].path[${index}].detail`,
    MAX_DETAIL_LENGTH,
    source,
    diagnostics,
    bindingId,
  );
  // An unrecognised tone is ignored, not diagnosed. Every other malformed field
  // here rejects the whole contribution, which is right for a key or a label but
  // not for a badge colour: it would mean a package compiled against a later
  // contract loses its entire menu on an older host over a cosmetic value. The
  // union type already catches a typo at every call site built against this
  // contract, which is the only place a typo can come from.
  const tone: DoomLeaderTone | undefined = value.tone === 'default' || value.tone === 'exit' ? value.tone : undefined;
  let order: number | undefined;
  if (value.order !== undefined) {
    if (!Number.isInteger(value.order) || (value.order as number) < 0 || (value.order as number) > MAX_OPTION_ORDER) {
      diagnostics.push(
        diagnostic(
          source,
          `bindings[].path[${index}].order must be an integer from 0 to ${MAX_OPTION_ORDER}.`,
          bindingId,
        ),
      );
    } else {
      order = value.order as number;
    }
  }
  if (!key || !label || !SAFE_KEY.test(key)) {
    if (key && !SAFE_KEY.test(key)) {
      diagnostics.push(diagnostic(source, `bindings[].path[${index}].key must match ${SAFE_KEY}.`, bindingId));
    }
    return undefined;
  }
  return {
    key,
    label,
    ...(detail ? { detail } : {}),
    ...(tone ? { tone } : {}),
    ...(order === undefined ? {} : { order }),
  };
}

function parseCommand(
  value: unknown,
  source: string,
  bindingId: string,
  diagnostics: DoomLeaderDiagnostic[],
): DoomLeaderCommand | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(source, 'bindings[].command must be an object.', bindingId));
    return undefined;
  }
  const name = readRequiredText(
    value.name,
    'bindings[].command.name',
    MAX_COMMAND_NAME_LENGTH,
    source,
    diagnostics,
    bindingId,
  );
  const args = readOptionalText(
    value.args,
    'bindings[].command.args',
    MAX_COMMAND_ARGUMENT_LENGTH,
    source,
    diagnostics,
    bindingId,
  );
  if (!name || !SAFE_COMMAND_NAME.test(name)) {
    if (name && !SAFE_COMMAND_NAME.test(name)) {
      diagnostics.push(diagnostic(source, `bindings[].command.name must match ${SAFE_COMMAND_NAME}.`, bindingId));
    }
    return undefined;
  }
  return { name, ...(args ? { args } : {}) };
}

function parseExtensionAction(
  value: unknown,
  source: string,
  bindingId: string,
  diagnostics: DoomLeaderDiagnostic[],
): DoomLeaderExtensionAction | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(source, 'bindings[].action must be an object.', bindingId));
    return undefined;
  }
  const name = readRequiredText(
    value.name,
    'bindings[].action.name',
    MAX_ACTION_NAME_LENGTH,
    source,
    diagnostics,
    bindingId,
  );
  if (!name || !SAFE_IDENTIFIER.test(name)) {
    if (name && !SAFE_IDENTIFIER.test(name)) {
      diagnostics.push(diagnostic(source, `bindings[].action.name must match ${SAFE_IDENTIFIER}.`, bindingId));
    }
    return undefined;
  }
  return { name };
}

function parseBinding(
  value: unknown,
  source: string,
  diagnostics: DoomLeaderDiagnostic[],
): DoomLeaderBinding | undefined {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(source, 'bindings[] must be an object.'));
    return undefined;
  }
  const bindingId = readRequiredText(value.id, 'bindings[].id', MAX_BINDING_ID_LENGTH, source, diagnostics);
  if (!bindingId) return undefined;
  if (!SAFE_IDENTIFIER.test(bindingId)) {
    diagnostics.push(diagnostic(source, `bindings[].id must match ${SAFE_IDENTIFIER}.`, bindingId));
    return undefined;
  }
  if (!Array.isArray(value.path) || value.path.length === 0 || value.path.length > MAX_PATH_LENGTH) {
    diagnostics.push(
      diagnostic(source, `bindings[].path must contain between 1 and ${MAX_PATH_LENGTH} segments.`, bindingId),
    );
    return undefined;
  }

  const path = value.path.map((segment, index) => parseSegment(segment, source, bindingId, index, diagnostics));
  const hasCommand = Object.hasOwn(value, 'command');
  const hasAction = Object.hasOwn(value, 'action');
  if (hasCommand === hasAction) {
    diagnostics.push(diagnostic(source, 'bindings[] must contain exactly one of command or action.', bindingId));
    return undefined;
  }
  const target = hasCommand
    ? { command: parseCommand(value.command, source, bindingId, diagnostics) }
    : { action: parseExtensionAction(value.action, source, bindingId, diagnostics) };
  if (path.some((segment) => segment === undefined)) return undefined;
  if ('command' in target) {
    if (!target.command) return undefined;
    return {
      id: bindingId,
      path: path as [DoomLeaderSegment, ...DoomLeaderSegment[]],
      command: target.command,
    };
  }
  if (!target.action) return undefined;
  return {
    id: bindingId,
    path: path as [DoomLeaderSegment, ...DoomLeaderSegment[]],
    action: target.action,
  };
}

function parseContribution(value: unknown): ParsedContribution {
  const diagnostics: DoomLeaderDiagnostic[] = [];
  if (!isRecord(value)) {
    return { diagnostics: [diagnostic(UNKNOWN_SOURCE, 'Leader contribution must be an object.')] };
  }
  const source = readRequiredText(value.source, 'source', MAX_SOURCE_LENGTH, UNKNOWN_SOURCE, diagnostics);
  if (!source) return { diagnostics };
  if (!SAFE_SOURCE.test(source)) {
    diagnostics.push(diagnostic(source, `source must match ${SAFE_SOURCE}.`));
    return { diagnostics };
  }
  if (!Array.isArray(value.bindings)) {
    return { diagnostics: [diagnostic(source, 'bindings must be an array.')] };
  }

  const bindings = value.bindings.map((binding) => parseBinding(binding, source, diagnostics));
  const duplicateIds = bindings
    .flatMap((binding) => (binding ? [binding.id] : []))
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicateIds)) {
    diagnostics.push(diagnostic(source, `Binding id '${id}' is duplicated.`, id));
  }
  if (diagnostics.length > 0 || bindings.some((binding) => binding === undefined)) return { diagnostics };

  return {
    contribution: {
      source,
      bindings: bindings as DoomLeaderBinding[],
    },
    diagnostics,
  };
}

function optionOrder(segment: DoomLeaderSegment): number {
  return segment.order ?? DEFAULT_OPTION_ORDER;
}

function cloneAction(action: DoomLeaderAction): DoomLeaderAction {
  if (action.type === 'command') return { type: 'command', command: { ...action.command } };
  if (action.type === 'app') return { type: 'app', action: action.action };
  return { type: 'extension', source: action.source, action: { ...action.action } };
}

function createRootNode(): LeaderNode {
  return {
    key: '',
    label: ROOT_LABEL,
    order: 0,
    owner: CORE_SOURCE,
    children: new Map(),
  };
}

function pathLabel(path: readonly DoomLeaderSegment[]): string {
  return `SPC ${path.map((segment) => segment.key).join(' ')}`;
}

/**
 * Whether a shared group prefix is worded the same way by both contributors.
 *
 * `detail` is left out on purpose: it is a subtitle, and these packages ship on
 * independent npm versions, so comparing it means one upgraded package disagrees
 * with every package that has not caught up.
 *
 * A mismatch is REPORTED, never fatal. Losing `SPC e s` because two packages
 * spell the `SPC e` group differently costs the user a key they can no longer
 * press, which is worse than a menu row worded by whoever registered first.
 */
function metadataMatches(node: LeaderNode, segment: DoomLeaderSegment): boolean {
  return node.label === segment.label && node.order === optionOrder(segment);
}

/** Every binding under a node, for a takeover message that says what it displaced. */
function leafCount(node: LeaderNode): number {
  if (node.children.size === 0) return node.action ? 1 : 0;
  let total = 0;
  for (const child of node.children.values()) total += leafCount(child);
  return total;
}

/**
 * Inserts one binding, taking a key over from whoever holds it.
 *
 * LAST REGISTRATION WINS, and the diagnostics say who lost what. The rule this
 * replaced rejected the newcomer, which read as "warning plus nothing happened":
 * the key stayed bound to the first registrant, or - when the clash was only a
 * group label - to nobody at all. A takeover is recoverable in a way a dropped
 * binding is not: the tree is rebuilt from every stored contribution, so when
 * the winner unregisters, the displaced binding comes back on the next rebuild.
 *
 * Returns diagnostics rather than one issue, because a single insert can both
 * disagree about a group's wording and take a key from someone.
 */
function insertBinding(root: LeaderNode, binding: InternalLeaderBinding): DoomLeaderDiagnostic[] {
  const diagnostics: DoomLeaderDiagnostic[] = [];
  let current = root;
  let firstMissing = -1;

  for (const [index, segment] of binding.path.entries()) {
    const existing = current.children.get(segment.key);
    if (!existing) {
      firstMissing = index;
      break;
    }
    if (!metadataMatches(existing, segment)) {
      diagnostics.push(
        diagnostic(
          binding.source,
          `${pathLabel(binding.path.slice(0, index + 1))} keeps the label from ${existing.owner}; the binding is registered.`,
          binding.id,
        ),
      );
    }
    // First writer wins for the subtitle, but a group created without one still
    // adopts the first that is offered, so the wording does not depend on which
    // package happened to register first.
    if (!existing.detail && segment.detail) existing.detail = segment.detail;

    const isLeaf = index === binding.path.length - 1;
    const displaced = leafCount(existing);
    if (isLeaf && displaced > 0) {
      diagnostics.push(
        diagnostic(
          binding.source,
          `${pathLabel(binding.path)} taken over from ${existing.owner}` +
            `${displaced > 1 ? `, displacing ${displaced} bindings` : ''}.`,
          binding.id,
        ),
      );
      existing.children.clear();
      delete existing.action;
      delete existing.bindingId;
    } else if (!isLeaf && existing.action) {
      diagnostics.push(
        diagnostic(
          binding.source,
          `${pathLabel(binding.path.slice(0, index + 1))} taken over from ${existing.owner} to open a group.`,
          binding.id,
        ),
      );
      delete existing.action;
      delete existing.bindingId;
    }
    if (isLeaf || existing.action === undefined) existing.owner = binding.source;
    current = existing;
  }

  const start = firstMissing === -1 ? binding.path.length : firstMissing;
  for (let index = start; index < binding.path.length; index += 1) {
    const segment = binding.path[index] as DoomLeaderSegment;
    const node: LeaderNode = {
      key: segment.key,
      label: segment.label,
      ...(segment.detail ? { detail: segment.detail } : {}),
      ...(segment.tone ? { tone: segment.tone } : {}),
      order: optionOrder(segment),
      owner: binding.source,
      children: new Map(),
    };
    current.children.set(segment.key, node);
    current = node;
  }

  current.action = cloneAction(binding.action);
  current.bindingId = binding.id;
  current.owner = binding.source;
  return diagnostics;
}

export class DoomLeaderRegistry {
  private root = createRootNode();
  private readonly contributions = new Map<string, readonly DoomLeaderBinding[]>();
  private readonly listeners = new Set<() => void>();
  private diagnostics: DoomLeaderDiagnostic[] = [];
  private dirty = false;

  constructor() {
    this.rebuild();
  }

  register(value: unknown): DoomLeaderRegistrationResult {
    const result = this.apply(value);
    if (!result.accepted) return result;
    this.rebuild();
    return { accepted: true, diagnostics: this.getDiagnostics() };
  }

  /** Records a contribution without rebuilding the whole tree immediately. */
  registerDeferred(value: unknown): DoomLeaderRegistrationResult {
    return this.apply(value);
  }

  private apply(value: unknown): DoomLeaderRegistrationResult {
    const parsed = parseContribution(value);
    if (!parsed.contribution) return { accepted: false, diagnostics: parsed.diagnostics };

    // Deleted before it is set again, so re-registering moves a source to the
    // back of the insertion order: registering again IS claiming again.
    this.contributions.delete(parsed.contribution.source);
    if (parsed.contribution.bindings.length > 0) {
      this.contributions.set(parsed.contribution.source, parsed.contribution.bindings);
    }
    this.dirty = true;
    return { accepted: true, diagnostics: parsed.diagnostics };
  }

  /** Rebuilds one batch and returns its deterministic conflict diagnostics. */
  flush(): DoomLeaderDiagnostic[] {
    if (this.dirty) this.rebuild();
    return this.diagnostics.map((item) => ({ ...item }));
  }

  getGroup(path: readonly string[]): DoomLeaderGroup | undefined {
    this.flush();
    let current = this.root;
    for (const key of path) {
      const next = current.children.get(key);
      if (!next || next.action) return undefined;
      current = next;
    }

    // The key is the sort, at every level. A reader looking for a chord knows the
    // key, not the number some contributor picked for it, and those numbers live
    // across nine packages so no one of them can see the sequence they produce.
    // `order` survives only as group identity: co-contributors to a shared prefix
    // must still agree on it, which is what `metadataMatches` checks.
    const options = [...current.children.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((node): DoomLeaderResolvedOption => ({
        key: node.key,
        label: node.label,
        ...(node.detail ? { detail: node.detail } : {}),
        ...(node.tone ? { tone: node.tone } : {}),
        hasChildren: node.children.size > 0,
        ...(node.action ? { action: cloneAction(node.action) } : {}),
      }));
    return { label: current.label, options };
  }

  getDiagnostics(): DoomLeaderDiagnostic[] {
    return this.flush();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private rebuild(): void {
    const nextRoot = createRootNode();
    const diagnostics: DoomLeaderDiagnostic[] = [];
    for (const binding of CORE_BINDINGS) {
      // Core bindings land in an empty tree, so anything reported here is two
      // core bindings disagreeing with each other: a defect, not a contribution.
      const [issue] = insertBinding(nextRoot, binding);
      if (issue) throw new Error(`Invalid core leader binding: ${issue.message}`);
    }

    // Registration order, not alphabetical: the key belongs to whoever claimed
    // it last, and `apply` re-seats a source that registers again so a reload
    // counts as a fresh claim. Bindings inside one contribution stay sorted by
    // id, so a single source's own output is still deterministic.
    for (const [source, bindings] of this.contributions.entries()) {
      for (const binding of [...bindings].sort((left, right) => left.id.localeCompare(right.id))) {
        diagnostics.push(
          ...insertBinding(nextRoot, {
            id: binding.id,
            source,
            path: binding.path,
            action:
              'command' in binding
                ? { type: 'command', command: binding.command }
                : { type: 'extension', source, action: binding.action },
          }),
        );
      }
    }

    this.root = nextRoot;
    this.diagnostics = diagnostics;
    this.dirty = false;
    for (const listener of this.listeners) listener();
  }
}
