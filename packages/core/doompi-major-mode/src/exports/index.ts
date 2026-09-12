export type { MajorModeCommandDependencies } from '../controllers/majorModeCommand';
export { createMajorModeTelemetry, type MajorModeTelemetryOptions } from '../services/logSinkTelemetry';
export {
  MAJOR_MODE_VOICE_INPUT_SCHEMA,
  MAJOR_MODE_VOICE_RESULT_SCHEMA,
  MAJOR_MODE_VOICE_TOOL_NAME,
  type MajorModeVoiceInput,
  type MajorModeVoiceResult,
} from '../schemas/majorModeVoiceTools';
export {
  applySummary,
  MAJOR_MODE_COMMAND,
  majorModeItems,
  majorModeOptionLabel,
  majorModeSummary,
  optionName,
  VOICE_SWITCH_TOKEN_PREFIX,
  voiceSwitchToken,
} from '../services/majorModeText';
export { bindPendingSelection, clearPendingSelection, selectionFromSnapshot } from '../controllers/pendingSelection';
export { colorStatus, STATUS_KEY, statusText } from '../services/statusLine';
export { MAJOR_MODE_SOURCE, MAJOR_MODE_SWITCH_HANDOFF_KIND, type MajorModeView } from '../types/majorMode';
export {
  MAJOR_MODE_EVENT,
  type MajorModeEventAttributes,
  type MajorModeEventName,
  type MajorModeTelemetry,
} from '../types/telemetry';
