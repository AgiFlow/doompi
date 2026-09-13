export const DOOM_VOICE_TOOLS_SERVICE = 'doom/voice-tools';
export const VOICE_DESCRIBE_TOOL_NAME = 'describe_voice_tools' as const;
export const VOICE_USE_TOOL_NAME = 'use_voice_tools' as const;
export const VOICE_FACADE_TOOL_NAMES = [VOICE_DESCRIBE_TOOL_NAME, VOICE_USE_TOOL_NAME] as const;
export const VOICE_NARRATE_TOOL_NAME = 'narrate' as const;
export const VOICE_MODE_TOOL_NAMES = [...VOICE_FACADE_TOOL_NAMES, VOICE_NARRATE_TOOL_NAME] as const;
export const VOICE_TOOL_DEFAULT_TIMEOUT_MS = 10_000;
export const VOICE_TOOL_MAX_TIMEOUT_MS = 30_000;
export const VOICE_TOOL_MAX_BATCH_ITEMS = 16;
export const VOICE_TOOL_MAX_INPUT_BYTES = 64 * 1024;
export const VOICE_TOOL_MAX_BATCH_BYTES = 256 * 1024;
export const VOICE_TOOL_MAX_SCHEMA_BYTES = 32 * 1024;
export const VOICE_TOOL_MAX_JSON_DEPTH = 16;
export const VOICE_TOOL_TERMINAL_OPERATION_LIMIT = 256;
export const VOICE_TOOL_MAX_IDENTIFIER_LENGTH = 128;
export const VOICE_TOOL_MAX_LABEL_LENGTH = 96;
export const VOICE_TOOL_MAX_DESCRIPTION_LENGTH = 240;
export const VOICE_TOOL_MAX_ERROR_MESSAGE_LENGTH = 240;
export const VOICE_TOOL_MAX_DOMAIN_COUNT = 32;
export const SAFE_IDENTIFIER = /^[A-Za-z0-9@][A-Za-z0-9@/._:-]*$/u;
export const SAFE_NAME = /^[a-z][a-z0-9_:-]*$/u;
export const MAX_ORDER = 1_000;
export const VOICE_TOOL_ERROR_CODE = {
  hostUnavailable: 'VOICE_TOOL_HOST_UNAVAILABLE',
  inactive: 'VOICE_TOOL_INACTIVE',
  staleSession: 'VOICE_TOOL_STALE_SESSION',
  staleCatalog: 'VOICE_TOOL_STALE_CATALOG',
  notFound: 'VOICE_TOOL_NOT_FOUND',
  nameConflict: 'VOICE_TOOL_NAME_CONFLICT',
  invalidInput: 'VOICE_TOOL_INVALID_INPUT',
  invalidResult: 'VOICE_TOOL_INVALID_RESULT',
  executionFailed: 'VOICE_TOOL_EXECUTION_FAILED',
  timeout: 'VOICE_TOOL_TIMEOUT',
  aborted: 'VOICE_TOOL_ABORTED',
  cancelled: 'VOICE_TOOL_CANCELLED',
  registrationDisposed: 'VOICE_TOOL_REGISTRATION_DISPOSED',
  sessionShutdown: 'VOICE_TOOL_SESSION_SHUTDOWN',
  batchStopped: 'VOICE_TOOL_BATCH_STOPPED',
  reloadQueued: 'VOICE_TOOL_RELOAD_QUEUED',
  invalidRequest: 'VOICE_TOOL_INVALID_REQUEST',
} as const;
export const VOICE_TOOL_HOST_UNAVAILABLE = VOICE_TOOL_ERROR_CODE.hostUnavailable;
export const VOICE_TOOL_INACTIVE = VOICE_TOOL_ERROR_CODE.inactive;
export const VOICE_TOOL_STALE_SESSION = VOICE_TOOL_ERROR_CODE.staleSession;
export const VOICE_TOOL_STALE_CATALOG = VOICE_TOOL_ERROR_CODE.staleCatalog;
export const VOICE_TOOL_NOT_FOUND = VOICE_TOOL_ERROR_CODE.notFound;
export const VOICE_TOOL_NAME_CONFLICT = VOICE_TOOL_ERROR_CODE.nameConflict;
export const VOICE_TOOL_INVALID_INPUT = VOICE_TOOL_ERROR_CODE.invalidInput;
export const VOICE_TOOL_INVALID_RESULT = VOICE_TOOL_ERROR_CODE.invalidResult;
export const VOICE_TOOL_TIMEOUT = VOICE_TOOL_ERROR_CODE.timeout;
export const VOICE_TOOL_ABORTED = VOICE_TOOL_ERROR_CODE.aborted;
export const VOICE_TOOL_EXECUTION_FAILED = VOICE_TOOL_ERROR_CODE.executionFailed;
export const VOICE_TOOL_BATCH_STOPPED = VOICE_TOOL_ERROR_CODE.batchStopped;

export const DOOM_VOICE_SOURCE = '@agimon-ai/doompi-voice';
export const DOOM_VOICE_AUTO_MODE_ID = 'voice-auto';
