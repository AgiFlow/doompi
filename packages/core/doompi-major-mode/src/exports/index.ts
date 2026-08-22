export { majorModeExtension } from '../adapters/pi/extension.ts';
export { registerMajorModeVoiceCapability } from '../adapters/pi/voiceTool.ts';
export { createMajorModeTelemetry, type MajorModeTelemetryOptions } from '../adapters/telemetry/logSinkTelemetry.ts';
export { registerMajorModeCommand, type MajorModeCommandDependencies } from '../commands/majorModeCommand.ts';
export {
  MAJOR_MODE_VOICE_INPUT_SCHEMA,
  MAJOR_MODE_VOICE_RESULT_SCHEMA,
  MAJOR_MODE_VOICE_TOOL_NAME,
  type MajorModeVoiceInput,
  type MajorModeVoiceResult,
} from '../schemas/majorModeVoiceTools.ts';
export {
  applySummary,
  MAJOR_MODE_COMMAND,
  majorModeItems,
  majorModeOptionLabel,
  majorModeSummary,
  optionName,
  VOICE_SWITCH_TOKEN_PREFIX,
  voiceSwitchToken,
} from '../services/majorModeText.ts';
export { bindPendingSelection, clearPendingSelection, selectionFromSnapshot } from '../services/pendingSelection.ts';
export { colorStatus, STATUS_KEY, statusText } from '../services/statusLine.ts';
export { MAJOR_MODE_SOURCE, MAJOR_MODE_SWITCH_HANDOFF_KIND, type MajorModeView } from '../types/majorMode.ts';
export {
  MAJOR_MODE_EVENT,
  type MajorModeEventAttributes,
  type MajorModeEventName,
  type MajorModeTelemetry,
} from '../types/telemetry.ts';
