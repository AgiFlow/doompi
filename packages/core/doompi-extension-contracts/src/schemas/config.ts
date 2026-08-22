/**
 * Configuration surfaces, contributed by every extension that owns settings.
 *
 * Doom settings live in one YAML file but are owned by many extensions, and for
 * a long time the only way to change any of them was to edit that file by hand.
 * The one exception, an editor-command prompt, asked for a value with no way to
 * see what a valid one looked like.
 *
 * So configuration is published rather than centralised: an extension describes
 * its own fields, one renderer draws them all, and the extension still performs
 * every write. Nothing here knows what a voice model or an editor command is.
 *
 * Deliberately the same shape as the mode and footer contracts next door, since
 * the problem is the same one: several extensions sharing one surface. The UI
 * hub invokes an owner's registered action directly, because unlike a status
 * strip this surface is written to as well as read.
 */

import { type Static, Type } from 'typebox';

/** Canonical Cordis key for the session-owned Doom configuration service. */
export const DOOM_CONFIG_SERVICE = 'doom/config';

/**
 * Cross-package service contract for the immutable configuration snapshot.
 *
 * The provider supplies the concrete snapshot and file-config types. Keeping
 * this contract generic lets independently bundled consumers share the Cordis
 * service definition without making the contracts package depend on config.
 */
export interface IDoomConfigService<TSnapshot = unknown, TFileConfig = unknown> {
  /** Identifies the currently published session service for stale-work fencing. */
  readonly generation: string;
  /** Returns the immutable snapshot currently visible to consumers. */
  getSnapshot(): TSnapshot;
  /** Atomically replaces the immutable live snapshot after a successful transition. */
  replaceSnapshot(snapshot: TSnapshot): TSnapshot;
  /** Loads the package's file configuration outside the live session snapshot. */
  load(repoRoot: string, homeDirectory?: string): TFileConfig;
}

/** Matches the leader contract's source rule: package names, addressable and spoof-checkable. */
export const ConfigSourceSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$',
});

const ConfigIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-z0-9][a-z0-9._:-]*$' });

/**
 * How ready a value is to be used, as opposed to whether it is merely set.
 * `blocked` covers a choice that needs something else first, such as a model
 * whose engine is not installed.
 */
export const ConfigStatusSchema = Type.Union([
  Type.Literal('ready'),
  Type.Literal('available'),
  Type.Literal('blocked'),
]);
export type ConfigStatus = Static<typeof ConfigStatusSchema>;

export const ConfigFieldKindSchema = Type.Union([
  /** Free text, edited in place. */
  Type.Literal('text'),
  /** A short closed set, cycled in place. */
  Type.Literal('enum'),
  /** A long set worth its own screen, with per-entry status and actions. */
  Type.Literal('choice'),
  /** Read-only. Resolution results, derived values, preflight checks. */
  Type.Literal('info'),
]);
export type ConfigFieldKind = Static<typeof ConfigFieldKindSchema>;

/**
 * A key the renderer offers on the focused field, sent back verbatim as an
 * action. Owners use this for confirmations, so the pending question survives a
 * panel that is closed and reopened.
 */
export const ConfigActionSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 1 }),
    label: Type.String({ minLength: 1, maxLength: 24 }),
    action: ConfigIdSchema,
  },
  { additionalProperties: false },
);
export type ConfigAction = Static<typeof ConfigActionSchema>;

export const ConfigChoiceSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    label: Type.String({ minLength: 1, maxLength: 96 }),
    /** Right-aligned by the renderer. Sizes, ids, anything narrow. */
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    /** Groups entries under a heading the cursor skips over. */
    group: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
    status: Type.Optional(ConfigStatusSchema),
    statusText: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    /**
     * What enter does on this entry. Carrying it per-entry is what lets one list
     * hold both an installed model that only needs selecting and an absent one
     * that needs fetching, without the renderer knowing the difference.
     */
    action: Type.Optional(ConfigIdSchema),
  },
  { additionalProperties: false },
);
export type ConfigChoice = Static<typeof ConfigChoiceSchema>;

/**
 * One line of a multi-step operation.
 *
 * Published as a list rather than a single "current step" string so the panel can
 * show what already ran alongside what is left. During an install that is the
 * difference between "something is happening" and knowing a package manager
 * already finished and a download is now underway.
 */
export const ConfigStepSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 96 }),
    state: Type.Union([
      Type.Literal('pending'),
      /** Already true of this machine, so nothing will run for it. */
      Type.Literal('satisfied'),
      Type.Literal('running'),
      Type.Literal('done'),
      Type.Literal('failed'),
    ]),
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  },
  { additionalProperties: false },
);
export type ConfigStep = Static<typeof ConfigStepSchema>;

export const ConfigProgressSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 96 }),
    /** 0 to 1. Omitted when the work has no measurable total. */
    ratio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);
export type ConfigProgress = Static<typeof ConfigProgressSchema>;

export const ConfigFieldSchema = Type.Object(
  {
    id: ConfigIdSchema,
    label: Type.String({ minLength: 1, maxLength: 48 }),
    kind: ConfigFieldKindSchema,
    /** Absent means unset; the renderer shows `placeholder` instead. */
    value: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    placeholder: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    /** One line of help for the focused field. */
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    /** The config key this writes, shown under the focused field so the file stays legible. */
    keyPath: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    status: Type.Optional(ConfigStatusSchema),
    /** Doubles as the error line: a rejected edit comes back as the old value plus this. */
    statusText: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    choices: Type.Optional(Type.Array(ConfigChoiceSchema, { maxItems: 128 })),
    actions: Type.Optional(Type.Array(ConfigActionSchema, { maxItems: 4 })),
    /** Work is running; the renderer dims the field and offers abort. */
    busy: Type.Optional(Type.Boolean()),
    progress: Type.Optional(ConfigProgressSchema),
    steps: Type.Optional(Type.Array(ConfigStepSchema, { maxItems: 24 })),
    /**
     * The tail of a running command's terminal output.
     *
     * A tail rather than the whole scrollback: the field is a few rows of a
     * shared pane, and what matters is the question a package manager just
     * asked, not what it printed a minute ago.
     */
    output: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })),
    /**
     * The command is waiting on the user. The renderer offers a line to type
     * into, which comes back as an owner-defined action carrying the text.
     */
    awaitingInput: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ConfigField = Static<typeof ConfigFieldSchema>;

export const ConfigSectionSchema = Type.Object(
  {
    id: ConfigIdSchema,
    title: Type.String({ minLength: 1, maxLength: 32 }),
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    order: Type.Integer({ minimum: 0, maximum: 1000 }),
    /** Section-wide state: readiness, or why a write failed. */
    notice: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    noticeLevel: Type.Optional(Type.Union([Type.Literal('info'), Type.Literal('error')])),
    fields: Type.Array(ConfigFieldSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type ConfigSection = Static<typeof ConfigSectionSchema>;

const ConfigSourceRefSchema = Type.Object(
  { source: ConfigSourceSchema, generation: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

const ConfigSnapshotSchema = Type.Object(
  { ...ConfigSourceRefSchema.properties, sections: Type.Array(ConfigSectionSchema, { maxItems: 32 }) },
  { additionalProperties: false },
);
export type ConfigSnapshot = Static<typeof ConfigSnapshotSchema>;
export type ConfigSourceRef = Static<typeof ConfigSourceRefSchema>;

export const CONFIG_ACTION = {
  set: 'set',
  clear: 'clear',
} as const;

export interface DoomExtensionContext {
  sessionManager: { getSessionId(): string };
}

export interface DoomConfigSectionView extends ConfigSection {
  source: string;
}

export interface DoomConfigInvocation {
  source: string;
  sectionId: string;
  fieldId: string;
  action: string;
  value?: string;
}

export interface DoomConfigActionInput<Context extends DoomExtensionContext = DoomExtensionContext> {
  ctx: Context;
  sectionId: string;
  fieldId: string;
  value?: string;
}

export interface DoomConfigContributionOptions<Context extends DoomExtensionContext = DoomExtensionContext> {
  source: string;
  listSections: () => readonly ConfigSection[];
  handlers: Readonly<Record<string, (input: DoomConfigActionInput<Context>) => void | Promise<void>>>;
  onError: (error: unknown, actionName: string, ctx: Context) => void;
}

export interface DoomConfigContributionHandle {
  update(): void;
  dispose(): void;
}
