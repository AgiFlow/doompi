export type {
  MinorModeActionAvailability,
  MinorModeActionDescriptor,
  MinorModeActionParameter,
  MinorModeActionRequest,
  MinorModeActionResponse,
  MinorModeActionProjection,
  MinorModeProjection,
  MinorModeRecordProjection,
  MinorModeActivation,
  MinorModeArguments,
  MinorModeCatalogSnapshot,
  MinorModeCondition,
  MinorModeDescriptor,
  MinorModeOwnerActionContext,
  MinorModeOwnerActionResult,
  MinorModeOwnerDefinition,
  MinorModeOwnerHandle,
  MinorModeRecord,
  MinorModeRegistrationRef,
  MinorModeScalar,
  MinorModeSessionKind,
  MinorModeState,
  MinorModeToolInput,
  ModeTextColor,
  MinorModeCatalogService,
  MinorModeInvokeOptions,
} from '../schemas/mode';
export {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  MINOR_MODE_ACTION_TIMEOUT_MS,
  MINOR_MODE_CATALOG_SOURCE,
  MINOR_MODE_ERROR_CODE,
  MINOR_MODE_MAX_ACTIONS,
  MINOR_MODE_MAX_ARGUMENT_LENGTH,
  MINOR_MODE_MAX_ENUM_CHOICES,
  MINOR_MODE_MAX_PARAMETERS,
  MINOR_MODE_MAX_RECORDS,
  MINOR_MODE_TOOL_NAME,
  MinorModeActionAvailabilitySchema,
  MinorModeActionRequestSchema,
  MinorModeActionResponseSchema,
  DOOM_MINOR_MODE_ENTRY_TYPE,
  MinorModeActionDescriptorSchema,
  MinorModeActionParameterSchema,
  MinorModeActivationSchema,
  MinorModeArgumentsSchema,
  MinorModeCatalogSnapshotSchema,
  MinorModeConditionSchema,
  MinorModeDescriptorSchema,
  MinorModeIdSchema,
  MinorModeParameterNameSchema,
  MinorModeRecordSchema,
  MinorModeRegistrationRefSchema,
  MinorModeScalarSchema,
  MinorModeSessionKindSchema,
  MinorModeSourceSchema,
  MinorModeStateSchema,
  MinorModeToolInputSchema,
  MinorModeToolResultSchema,
  ModeTextColorSchema,
  readMinorModeCatalog,
  requireMinorModeCatalog,
} from '../schemas/mode';
export type { MinorModeCatalogClient } from '../services/client';
export { createMinorModeCatalogClient } from '../services/client';
export { registerMinorModeOwner } from '../services/owner';
export {
  defineMinorMode,
  type DefinedMinorMode,
  type MinorModeDefinition,
  type MinorModeExecution,
  type MinorModeOwner,
} from '../services/modeDefinition';
export {
  minorModeKey,
  minorModeRegistrationRef,
  validateMinorModeActionArguments,
  validateMinorModeDefinition,
} from '../services/validation';

export { piMinorModes, type PiMinorModeContribution, type PiMinorModeCollection } from '../services/piRegistration';
export { serverMinorModes } from '../services/serverRegistration';

export type { DoomHeadlessMinorMode } from '../schemas/headless';
export { headlessMinorModeCommand } from '../services/headlessCommand';
