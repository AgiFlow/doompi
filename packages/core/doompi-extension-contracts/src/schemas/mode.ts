import type { Context } from '@deepseek-ai/cordis';
import { type Static, Type } from 'typebox';
import type { DoomExtensionContext } from './config.ts';

export const MINOR_MODE_CATALOG_SOURCE = '@agimon-ai/doompi/mode-catalog';
export const DOOM_MINOR_MODE_CATALOG_SERVICE = 'doom/minor-mode-catalog';
export const MINOR_MODE_TOOL_NAME = 'minor_mode';
export const MINOR_MODE_ACTION_TIMEOUT_MS = 30_000;
export const MINOR_MODE_MAX_RECORDS = 128;
export const MINOR_MODE_MAX_ACTIONS = 16;
export const MINOR_MODE_MAX_PARAMETERS = 16;
export const MINOR_MODE_MAX_ENUM_CHOICES = 32;
export const MINOR_MODE_MAX_ARGUMENT_LENGTH = 4_096;

const MAX_SOURCE_LENGTH = 128;
const MAX_ID_LENGTH = 128;
const MAX_GENERATION_LENGTH = 256;
const MAX_LABEL_LENGTH = 48;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_DETAIL_LENGTH = 160;

export const MINOR_MODE_ERROR_CODE = {
  actionAborted: 'MINOR_MODE_ACTION_ABORTED',
  actionDisabled: 'MINOR_MODE_ACTION_DISABLED',
  actionNotFound: 'MINOR_MODE_ACTION_NOT_FOUND',
  actionTimeout: 'MINOR_MODE_ACTION_TIMEOUT',
  invalidArguments: 'MINOR_MODE_INVALID_ARGUMENTS',
  modeBusy: 'MINOR_MODE_BUSY',
  modeNotFound: 'MINOR_MODE_NOT_FOUND',
  ownerFailed: 'MINOR_MODE_OWNER_FAILED',
  registrationConflict: 'MINOR_MODE_REGISTRATION_CONFLICT',
  sessionReplaced: 'MINOR_MODE_SESSION_REPLACED',
  staleRegistration: 'MINOR_MODE_STALE_REGISTRATION',
  unsupportedContext: 'MINOR_MODE_UNSUPPORTED_CONTEXT',
} as const;

export const MinorModeSourceSchema = Type.String({
  minLength: 1,
  maxLength: MAX_SOURCE_LENGTH,
  pattern: '^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$',
});
export const MinorModeIdSchema = Type.String({
  minLength: 1,
  maxLength: MAX_ID_LENGTH,
  pattern: '^[a-z0-9][a-z0-9._:-]*$',
});
export const MinorModeParameterNameSchema = Type.String({
  minLength: 1,
  maxLength: MAX_ID_LENGTH,
  pattern: '^[a-z][A-Za-z0-9._:-]*$',
});
const GenerationSchema = Type.String({ minLength: 1, maxLength: MAX_GENERATION_LENGTH });
const LabelSchema = Type.String({ minLength: 1, maxLength: MAX_LABEL_LENGTH });
const DescriptionSchema = Type.String({ minLength: 1, maxLength: MAX_DESCRIPTION_LENGTH });
const OperationIdSchema = Type.String({ minLength: 1, maxLength: MAX_GENERATION_LENGTH });

export const ModeTextColorSchema = Type.Union([
  Type.Literal('accent'),
  Type.Literal('warning'),
  Type.Literal('mdHeading'),
  Type.Literal('muted'),
  Type.Literal('dim'),
]);
export type ModeTextColor = Static<typeof ModeTextColorSchema>;

export const MinorModeSessionKindSchema = Type.Union([Type.Literal('tui'), Type.Literal('headless')]);
export type MinorModeSessionKind = Static<typeof MinorModeSessionKindSchema>;

export const MinorModeActivationSchema = Type.Union([
  Type.Literal('inactive'),
  Type.Literal('activating'),
  Type.Literal('active'),
  Type.Literal('deactivating'),
]);
export type MinorModeActivation = Static<typeof MinorModeActivationSchema>;

export const MinorModeConditionSchema = Type.Union([
  Type.Literal('ready'),
  Type.Literal('paused'),
  Type.Literal('blocked'),
  Type.Literal('limited'),
  Type.Literal('queued'),
  Type.Literal('degraded'),
  Type.Literal('failed'),
]);
export type MinorModeCondition = Static<typeof MinorModeConditionSchema>;

export const MinorModeScalarSchema = Type.Union([
  Type.String({ maxLength: MINOR_MODE_MAX_ARGUMENT_LENGTH }),
  Type.Number(),
  Type.Boolean(),
]);
export type MinorModeScalar = Static<typeof MinorModeScalarSchema>;

const ParameterBase = {
  name: MinorModeParameterNameSchema,
  label: LabelSchema,
  description: Type.Optional(DescriptionSchema),
  required: Type.Boolean(),
};

export const MinorModeActionParameterSchema = Type.Union([
  Type.Object(
    {
      ...ParameterBase,
      kind: Type.Literal('string'),
      minLength: Type.Optional(Type.Integer({ minimum: 0, maximum: MINOR_MODE_MAX_ARGUMENT_LENGTH })),
      maxLength: Type.Optional(Type.Integer({ minimum: 1, maximum: MINOR_MODE_MAX_ARGUMENT_LENGTH })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...ParameterBase,
      kind: Type.Literal('number'),
      integer: Type.Optional(Type.Boolean()),
      minimum: Type.Optional(Type.Number()),
      maximum: Type.Optional(Type.Number()),
    },
    { additionalProperties: false },
  ),
  Type.Object({ ...ParameterBase, kind: Type.Literal('boolean') }, { additionalProperties: false }),
  Type.Object(
    {
      ...ParameterBase,
      kind: Type.Literal('enum'),
      choices: Type.Array(
        Type.Object(
          {
            value: Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH }),
            label: LabelSchema,
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: MINOR_MODE_MAX_ENUM_CHOICES },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type MinorModeActionParameter = Static<typeof MinorModeActionParameterSchema>;

export const MinorModeActionDescriptorSchema = Type.Object(
  {
    id: MinorModeIdSchema,
    label: LabelSchema,
    description: DescriptionSchema,
    contexts: Type.Array(MinorModeSessionKindSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
    parameters: Type.Array(MinorModeActionParameterSchema, { maxItems: MINOR_MODE_MAX_PARAMETERS }),
  },
  { additionalProperties: false },
);
export type MinorModeActionDescriptor = Static<typeof MinorModeActionDescriptorSchema>;

export const MinorModeDescriptorSchema = Type.Object(
  {
    source: MinorModeSourceSchema,
    id: MinorModeIdSchema,
    label: LabelSchema,
    description: DescriptionSchema,
    order: Type.Integer({ minimum: 0, maximum: 1_000 }),
    actions: Type.Array(MinorModeActionDescriptorSchema, { maxItems: MINOR_MODE_MAX_ACTIONS }),
  },
  { additionalProperties: false },
);
export type MinorModeDescriptor = Static<typeof MinorModeDescriptorSchema>;

export const MinorModeActionAvailabilitySchema = Type.Object(
  {
    id: MinorModeIdSchema,
    enabled: Type.Boolean(),
    disabledReason: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_DETAIL_LENGTH })),
  },
  { additionalProperties: false },
);
export type MinorModeActionAvailability = Static<typeof MinorModeActionAvailabilitySchema>;

export const MinorModeStateSchema = Type.Object(
  {
    activation: MinorModeActivationSchema,
    condition: MinorModeConditionSchema,
    detail: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_DETAIL_LENGTH })),
    color: Type.Optional(ModeTextColorSchema),
    modelContextVariant: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH })),
    actions: Type.Array(MinorModeActionAvailabilitySchema, { maxItems: MINOR_MODE_MAX_ACTIONS }),
  },
  { additionalProperties: false },
);
export type MinorModeState = Static<typeof MinorModeStateSchema>;

export const MinorModeRegistrationRefSchema = Type.Object(
  {
    source: MinorModeSourceSchema,
    id: MinorModeIdSchema,
    ownerGeneration: GenerationSchema,
    registrationId: GenerationSchema,
  },
  { additionalProperties: false },
);
export type MinorModeRegistrationRef = Static<typeof MinorModeRegistrationRefSchema>;

export const MinorModeRecordSchema = Type.Object(
  {
    descriptor: MinorModeDescriptorSchema,
    state: MinorModeStateSchema,
    ownerGeneration: GenerationSchema,
    registrationId: GenerationSchema,
    stateRevision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type MinorModeRecord = Static<typeof MinorModeRecordSchema>;

export const MinorModeCatalogSnapshotSchema = Type.Object(
  {
    hostGeneration: GenerationSchema,
    revision: Type.Integer({ minimum: 0 }),
    modes: Type.Array(MinorModeRecordSchema, { maxItems: MINOR_MODE_MAX_RECORDS }),
  },
  { additionalProperties: false },
);
export type MinorModeCatalogSnapshot = Static<typeof MinorModeCatalogSnapshotSchema>;

export const MinorModeArgumentsSchema = Type.Record(MinorModeParameterNameSchema, MinorModeScalarSchema, {
  maxProperties: MINOR_MODE_MAX_PARAMETERS,
});
export type MinorModeArguments = Static<typeof MinorModeArgumentsSchema>;

export const MinorModeToolInputSchema = Type.Object(
  {
    action: Type.Union([Type.Literal('list'), Type.Literal('invoke')]),
    source: Type.Optional(MinorModeSourceSchema),
    id: Type.Optional(MinorModeIdSchema),
    ownerGeneration: Type.Optional(GenerationSchema),
    registrationId: Type.Optional(GenerationSchema),
    modeAction: Type.Optional(MinorModeIdSchema),
    arguments: Type.Optional(MinorModeArgumentsSchema),
  },
  { additionalProperties: false },
);
export type MinorModeToolInput = Static<typeof MinorModeToolInputSchema>;
export const MinorModeToolResultSchema = Type.Unknown();

export const MinorModeActionRequestSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    mode: MinorModeRegistrationRefSchema,
    actionId: MinorModeIdSchema,
    arguments: MinorModeArgumentsSchema,
  },
  { additionalProperties: false },
);
export type MinorModeActionRequest = Static<typeof MinorModeActionRequestSchema>;

export const MinorModeActionResponseSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    catalogRevision: Type.Integer({ minimum: 0 }),
    mode: MinorModeRecordSchema,
    message: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_DETAIL_LENGTH })),
  },
  { additionalProperties: false },
);
export type MinorModeActionResponse = Static<typeof MinorModeActionResponseSchema>;

/**
 * The custom session entry the catalog host journals whenever its projection
 * changes. It rides Pi's entry_appended frames, so any RPC client (the web
 * cockpit) sees minor-mode state live and on replay without a new protocol.
 */
export const DOOM_MINOR_MODE_ENTRY_TYPE = 'doom-minor-modes';

export interface MinorModeActionProjection {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  /** Whether invoking it needs arguments a client must ask for first. */
  readonly needsInput: boolean;
}

export interface MinorModeRecordProjection {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly order: number;
  readonly activation: MinorModeActivation;
  readonly condition: MinorModeCondition;
  readonly detail?: string;
  readonly actions: readonly MinorModeActionProjection[];
}

export interface MinorModeProjection {
  readonly version: 1;
  readonly revision: number;
  readonly modes: readonly MinorModeRecordProjection[];
}

export interface MinorModeOwnerActionResult {
  message?: string;
}

export interface MinorModeOwnerActionContext<ExtensionContext extends DoomExtensionContext> {
  context: ExtensionContext;
  operationId: string;
  sessionKind: MinorModeSessionKind;
  signal: AbortSignal;
}

export interface MinorModeOwnerDefinition<ExtensionContext extends DoomExtensionContext> {
  descriptor: MinorModeDescriptor;
  initialState: MinorModeState;
  handleAction(
    actionId: string,
    argumentsValue: MinorModeArguments,
    execution: MinorModeOwnerActionContext<ExtensionContext>,
  ): MinorModeOwnerActionResult | void | Promise<MinorModeOwnerActionResult | void>;
  onError?(error: unknown): void;
}

export interface MinorModeOwnerHandle {
  getState(): MinorModeState;
  publish(state: MinorModeState): void;
  dispose(): void;
}

export interface MinorModeInvokeOptions {
  readonly signal?: AbortSignal;
}

/** Direct session-local catalog shared through Cordis. */
export interface MinorModeCatalogService {
  readonly generation: string;
  getSnapshot(): MinorModeCatalogSnapshot;
  list(): MinorModeRecord[];
  subscribe(listener: () => void): () => void;
  registerOwner<ExtensionContext extends DoomExtensionContext>(
    definition: MinorModeOwnerDefinition<ExtensionContext>,
  ): MinorModeOwnerHandle;
  invoke(
    request: MinorModeActionRequest,
    requesterSource: string,
    signal?: AbortSignal,
  ): Promise<MinorModeActionResponse>;
  dispose(): void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/minor-mode-catalog': MinorModeCatalogService;
  }
}

export function readMinorModeCatalog(context: Context): MinorModeCatalogService | undefined {
  return context.get(DOOM_MINOR_MODE_CATALOG_SERVICE) as MinorModeCatalogService | undefined;
}

export function requireMinorModeCatalog(context: Context): MinorModeCatalogService {
  const catalog = readMinorModeCatalog(context);
  if (!catalog) throw new Error('Doom minor-mode catalog is unavailable.');
  return catalog;
}
