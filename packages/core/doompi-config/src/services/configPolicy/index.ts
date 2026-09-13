import { parse as parseYaml } from 'yaml';

import type {
  AutocompactModeConfig,
  AutocompactOverrideConfig,
  AutocompactThresholdConfig,
  ComputerUseConfig,
  ConfigDiagnostic,
  DoomConfig,
  DoomSelectionConfig,
  EditorConfig,
  LenientParseOptions,
  LenientParseResult,
  PlanningAgentConfig,
  PlanningModeConfig,
  PlanningThinkingLevel,
  ProjectTrust,
  ResolvedVoiceConfig,
  VoiceAdapterConfig,
  VoiceAutoCaptureConfig,
  VoiceConfig,
  VoiceEngine,
  VoiceMode,
  VoiceModelConfig,
  VoiceTtsConfig,
  VoiceTtsEngine,
} from '../../types/config';
import type { PersonaVoiceOverride } from '../../types/profiles';

const DEFAULT_PROJECT_TRUST: ProjectTrust = 'ask';
const DEFAULT_VOICE_MODE: VoiceMode = 'legacy';
const DEFAULT_VOICE_ENGINE: VoiceEngine = 'auto';
const DEFAULT_VOICE_LANGUAGE = 'auto';
const DEFAULT_RECORDER_DEVICE = 'none:default';
const ROOT_KEYS = ['modes', 'computerUse', 'projectTrust', 'editor', 'voice', 'selection'] as const;
const SELECTION_KEYS = ['majorMode', 'domains', 'profile'] as const;
const MODE_KEYS = ['planning', 'autocompact'] as const;
const PLANNING_KEYS = ['main', 'subagents', 'plansDirectory'] as const;
const AGENT_KEYS = ['model', 'thinking'] as const;
const AUTOCOMPACT_KEYS = ['enabled', 'model', 'thinking', 'thresholds', 'overrides'] as const;
const AUTOCOMPACT_THRESHOLD_KEYS = ['pass1', 'pass2', 'pass3'] as const;
const AUTOCOMPACT_OVERRIDE_KEYS = ['model', 'tokens'] as const;
const COMPUTER_USE_KEYS = ['enabled'] as const;
/** A pass that fires below this is noise; one above it never fires before Pi compacts natively. */
const MIN_AUTOCOMPACT_RATIO = 0.05;
const MAX_AUTOCOMPACT_RATIO = 0.99;
/**
 * A checkpoint at zero tokens fires before the session has said anything. There is
 * deliberately no ceiling: the package takes the lower of the ratio and the token
 * value, so one larger than the window is inert rather than dangerous.
 */
const MIN_AUTOCOMPACT_TOKENS = 1;
const EDITOR_KEYS = ['command'] as const;
const VOICE_KEYS = ['mode', 'engine', 'language', 'recorder', 'adapters', 'autoCapture'] as const;
const RECORDER_KEYS = ['binary', 'device'] as const;
const WHISPER_CPP_ENGINE = 'whisper-cpp' as const;
const OPENAI_WHISPER_ENGINE = 'openai-whisper' as const;
const MLX_WHISPER_ENGINE = 'mlx-whisper' as const;
const MACOS_SAY_TTS_ENGINE = 'macos-say' as const;
const ADAPTERS_KEYS = [WHISPER_CPP_ENGINE, OPENAI_WHISPER_ENGINE, MLX_WHISPER_ENGINE] as const;
const ADAPTER_KEYS = ['binary', 'model'] as const;
const MODEL_KEYS = ['path', 'id'] as const;
const AUTO_CAPTURE_KEYS = [
  'model',
  'startPhrases',
  'stopPhrases',
  'composeOpenPhrases',
  'composeSendPhrases',
  'composeCancelPhrases',
  'utteranceIdleMs',
  'composeUtteranceIdleMs',
  'composeNudgeMs',
  'transcriptionTimeoutMs',
  'tts',
] as const;
const TTS_KEYS = ['engine', 'voice', 'rate'] as const;
const DEFAULT_UTTERANCE_IDLE_MS = 3_000;
const MIN_UTTERANCE_IDLE_MS = 1_500;
const MAX_UTTERANCE_IDLE_MS = 10_000;
/**
 * The endpoint window used while a composition draft is collecting.
 *
 * Shorter than `utteranceIdleMs` on purpose. A turn produces exactly one transcript, so
 * with the ordinary ~3 s window a short command spoken after a brief pause arrives glued
 * to the end of the preceding sentence and can never be read as a command. Roughly twice
 * the VAD's own 600 ms trailing-silence window: long enough that ordinary speech rhythm
 * does not split a sentence, short enough that a deliberate pause does. Over-splitting is
 * harmless here and only here, because draft segments are joined back together with a
 * space.
 */
const DEFAULT_COMPOSE_UTTERANCE_IDLE_MS = 1_200;
const MIN_COMPOSE_UTTERANCE_IDLE_MS = 800;
const MAX_COMPOSE_UTTERANCE_IDLE_MS = 3_000;
/** Silence before Voice reminds the user a draft is still open. `0` disables it. */
const DEFAULT_COMPOSE_NUDGE_MS = 10_000;
const MIN_COMPOSE_NUDGE_MS = 5_000;
const MAX_COMPOSE_NUDGE_MS = 60_000;
/**
 * Defaults kept as lists so the phrases that shipped first keep working.
 *
 * `hey doom` and `that's it` read as speech; `doom prompt` and `doom send` are what
 * existing users have in their fingers. Dropping the originals would break them for no
 * gain, and the cost of carrying both is two extra comparisons per command candidate.
 */
const DEFAULT_COMPOSE_OPEN_PHRASES = ['hey doom', 'doom prompt'] as const;
const DEFAULT_COMPOSE_SEND_PHRASES = ["that's it", 'doom send'] as const;
const DEFAULT_COMPOSE_CANCEL_PHRASES = ['doom cancel', 'scratch that'] as const;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 15_000;
const MIN_TRANSCRIPTION_TIMEOUT_MS = 1_000;
const MAX_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const MAX_CONTROL_PHRASES = 16;
const MAX_CONTROL_PHRASE_LENGTH = 64;
const MAX_TTS_VOICE_LENGTH = 64;
const MIN_TTS_RATE = 80;
const MAX_TTS_RATE = 500;
const MODEL_REFERENCE_PATTERN = /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/u;
const PHRASE_PUNCTUATION_PATTERN = /[\p{P}\p{S}]+/gu;
/**
 * The accepted values, in the order a picker should offer them.
 *
 * Exported because the config UI has to offer exactly what the parser accepts,
 * and a second hand-written list in the contributing package would drift. The
 * validating Sets below are built from these for the same reason.
 */
export const DOOM_PLANNING_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const DOOM_VOICE_MODES = [DEFAULT_VOICE_MODE, 'live'] as const;
export const DOOM_VOICE_ENGINES = [
  DEFAULT_VOICE_ENGINE,
  WHISPER_CPP_ENGINE,
  OPENAI_WHISPER_ENGINE,
  MLX_WHISPER_ENGINE,
] as const;
export const DOOM_VOICE_TTS_ENGINES = [MACOS_SAY_TTS_ENGINE] as const;

const THINKING_VALUES = new Set<PlanningThinkingLevel>(DOOM_PLANNING_THINKING_LEVELS);
const TRUST_VALUES = new Set<ProjectTrust>(['ask', 'always', 'never']);
const VOICE_MODE_VALUES = new Set<VoiceMode>(DOOM_VOICE_MODES);
const ENGINE_VALUES = new Set<VoiceEngine>(DOOM_VOICE_ENGINES);
const TTS_ENGINE_VALUES = new Set<VoiceTtsEngine>(DOOM_VOICE_TTS_ENGINES);
type ConfigObject = Record<string, unknown>;

function isObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Where a lenient parse collects unknown keys instead of throwing.
 *
 * Module scope rather than a parameter threaded through the twelve nested
 * parsers: `assertKeys` is the only reader, parsing is synchronous end to end,
 * and `parseDoomConfig` owns the whole window in a try/finally. Threading would
 * touch every parser to change behaviour in one of them.
 */
let unknownKeySink: ConfigDiagnostic[] | undefined;

function assertKeys(value: ConfigObject, allowed: readonly string[], location: string, filePath: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  if (unknownKeySink !== undefined) {
    // Left on the object rather than deleted: every parser reads the fields it
    // knows by name, so an unknown sibling is already inert.
    for (const key of unknown) {
      unknownKeySink.push({
        filePath,
        path: location === 'root' ? key : `${location}.${key}`,
        message: `unsupported ${location} field`,
      });
    }
    return;
  }
  throw new Error(`Doom config at ${filePath} has unsupported ${location} field(s): ${unknown.join(', ')}`);
}
function optionalString(value: unknown, location: string, filePath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`Doom config at ${filePath} requires ${location} to be a non-empty string`);
  return value.trim();
}
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
function boundedOptionalString(
  value: unknown,
  location: string,
  filePath: string,
  maximumLength: number,
): string | undefined {
  const text = optionalString(value, location, filePath);
  if (!text) return undefined;
  if (text.length > maximumLength)
    throw new Error(`Doom config at ${filePath} requires ${location} to be at most ${maximumLength} characters`);
  if (hasControlCharacters(text))
    throw new Error(`Doom config at ${filePath} does not allow control characters in ${location}`);
  return text;
}
function parseModelReference(value: unknown, filePath: string): string {
  const location = 'voice.autoCapture.model';
  const model = optionalString(value, location, filePath);
  if (!model || !MODEL_REFERENCE_PATTERN.test(model))
    throw new Error(`Doom config at ${filePath} requires ${location} in provider/model-id form`);
  return model;
}
function normalizeControlPhrase(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(PHRASE_PUNCTUATION_PATTERN, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
function parseControlPhrases(value: unknown, location: string, filePath: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((phrase) => typeof phrase !== 'string'))
    throw new Error(`Doom config at ${filePath} requires ${location} to be an array of strings`);
  if (value.length > MAX_CONTROL_PHRASES)
    throw new Error(
      `Doom config at ${filePath} requires ${location} to contain at most ${MAX_CONTROL_PHRASES} phrases`,
    );
  const phrases = value.map((phrase) => phrase.trim());
  const normalized = new Set<string>();
  for (const phrase of phrases) {
    if (phrase.length === 0)
      throw new Error(`Doom config at ${filePath} requires ${location} to contain non-empty strings`);
    if (phrase.length > MAX_CONTROL_PHRASE_LENGTH)
      throw new Error(
        `Doom config at ${filePath} requires ${location} phrases to be at most ${MAX_CONTROL_PHRASE_LENGTH} characters`,
      );
    if (hasControlCharacters(phrase))
      throw new Error(`Doom config at ${filePath} does not allow control characters in ${location}`);
    const key = normalizeControlPhrase(phrase);
    if (!key) throw new Error(`Doom config at ${filePath} requires ${location} to contain words`);
    if (normalized.has(key))
      throw new Error(`Doom config at ${filePath} does not allow normalized duplicates in ${location}`);
    normalized.add(key);
  }
  return phrases;
}
function parseBoundedInteger(
  value: unknown,
  location: string,
  filePath: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`Doom config at ${filePath} requires ${location} to be an integer from ${minimum} to ${maximum}`);
  return value;
}
/**
 * Rejects a phrase claimed by two control roles at once.
 *
 * Composition commands are adjudicated before stop phrases and before leading
 * start-phrase removal, so a phrase shared with a later role is not ambiguous, it is
 * silently unreachable. Without a screen there is nothing to show which role won.
 */
function assertDisjointPhrases(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
  leftName: string,
  rightName: string,
  filePath: string,
): void {
  const keys = new Set((left ?? []).map(normalizeControlPhrase));
  if ((right ?? []).some((phrase) => keys.has(normalizeControlPhrase(phrase))))
    throw new Error(`Doom config at ${filePath} does not allow a phrase in both ${leftName} and ${rightName}`);
}
function parseTtsConfig(value: unknown, filePath: string): VoiceTtsConfig {
  const location = 'voice.autoCapture.tts';
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, TTS_KEYS, location, filePath);
  if (typeof value.engine !== 'string' || !TTS_ENGINE_VALUES.has(value.engine as VoiceTtsEngine))
    throw new Error(
      `Doom config at ${filePath} requires ${location}.engine to be one of: ${[...TTS_ENGINE_VALUES].join(', ')}`,
    );
  const voice = boundedOptionalString(value.voice, `${location}.voice`, filePath, MAX_TTS_VOICE_LENGTH);
  const rate = value.rate;
  if (
    rate !== undefined &&
    (typeof rate !== 'number' || !Number.isInteger(rate) || rate < MIN_TTS_RATE || rate > MAX_TTS_RATE)
  ) {
    throw new Error(
      `Doom config at ${filePath} requires ${location}.rate to be an integer from ${MIN_TTS_RATE} to ${MAX_TTS_RATE}`,
    );
  }
  return {
    engine: value.engine as VoiceTtsEngine,
    ...(voice ? { voice } : {}),
    ...(rate === undefined ? {} : { rate }),
  };
}
function parseAutoCapture(value: unknown, filePath: string): VoiceAutoCaptureConfig | undefined {
  if (value === undefined) return undefined;
  const location = 'voice.autoCapture';
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, AUTO_CAPTURE_KEYS, location, filePath);
  const startPhrases = parseControlPhrases(value.startPhrases, `${location}.startPhrases`, filePath);
  const stopPhrases = parseControlPhrases(value.stopPhrases, `${location}.stopPhrases`, filePath);
  const composeOpenPhrases = parseControlPhrases(value.composeOpenPhrases, `${location}.composeOpenPhrases`, filePath);
  const composeSendPhrases = parseControlPhrases(value.composeSendPhrases, `${location}.composeSendPhrases`, filePath);
  const composeCancelPhrases = parseControlPhrases(
    value.composeCancelPhrases,
    `${location}.composeCancelPhrases`,
    filePath,
  );
  const utteranceIdleMs = parseBoundedInteger(
    value.utteranceIdleMs,
    `${location}.utteranceIdleMs`,
    filePath,
    MIN_UTTERANCE_IDLE_MS,
    MAX_UTTERANCE_IDLE_MS,
  );
  const composeUtteranceIdleMs = parseBoundedInteger(
    value.composeUtteranceIdleMs,
    `${location}.composeUtteranceIdleMs`,
    filePath,
    MIN_COMPOSE_UTTERANCE_IDLE_MS,
    MAX_COMPOSE_UTTERANCE_IDLE_MS,
  );
  // Zero is the documented off switch, so it is accepted outside the range rather than
  // forcing a separate boolean that could disagree with the interval.
  const composeNudgeMs =
    value.composeNudgeMs === 0
      ? 0
      : parseBoundedInteger(
          value.composeNudgeMs,
          `${location}.composeNudgeMs`,
          filePath,
          MIN_COMPOSE_NUDGE_MS,
          MAX_COMPOSE_NUDGE_MS,
        );
  const transcriptionTimeoutMs = parseBoundedInteger(
    value.transcriptionTimeoutMs,
    `${location}.transcriptionTimeoutMs`,
    filePath,
    MIN_TRANSCRIPTION_TIMEOUT_MS,
    MAX_TRANSCRIPTION_TIMEOUT_MS,
  );
  assertDisjointPhrases(startPhrases, stopPhrases, 'startPhrases', 'stopPhrases', filePath);
  // `composeOpenPhrases` may overlap `startPhrases`: addressing the agent and opening a
  // draft are the same gesture, composition is adjudicated first, and the shipped
  // defaults deliberately share `hey doom`.
  assertDisjointPhrases(
    composeSendPhrases,
    composeCancelPhrases,
    'composeSendPhrases',
    'composeCancelPhrases',
    filePath,
  );
  assertDisjointPhrases(composeOpenPhrases, composeSendPhrases, 'composeOpenPhrases', 'composeSendPhrases', filePath);
  assertDisjointPhrases(
    composeOpenPhrases,
    composeCancelPhrases,
    'composeOpenPhrases',
    'composeCancelPhrases',
    filePath,
  );
  assertDisjointPhrases(stopPhrases, composeSendPhrases, 'stopPhrases', 'composeSendPhrases', filePath);
  assertDisjointPhrases(stopPhrases, composeCancelPhrases, 'stopPhrases', 'composeCancelPhrases', filePath);
  return {
    model: parseModelReference(value.model, filePath),
    ...(startPhrases ? { startPhrases } : {}),
    ...(stopPhrases ? { stopPhrases } : {}),
    ...(composeOpenPhrases ? { composeOpenPhrases } : {}),
    ...(composeSendPhrases ? { composeSendPhrases } : {}),
    ...(composeCancelPhrases ? { composeCancelPhrases } : {}),
    ...(utteranceIdleMs === undefined ? {} : { utteranceIdleMs }),
    ...(composeUtteranceIdleMs === undefined ? {} : { composeUtteranceIdleMs }),
    ...(composeNudgeMs === undefined ? {} : { composeNudgeMs }),
    ...(transcriptionTimeoutMs === undefined ? {} : { transcriptionTimeoutMs }),
    tts: parseTtsConfig(value.tts, filePath),
  };
}
function parseThinking(value: unknown, location: string, filePath: string): PlanningThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !THINKING_VALUES.has(value as PlanningThinkingLevel)) {
    throw new Error(
      `Doom config at ${filePath} requires ${location}.thinking to be one of: ${[...THINKING_VALUES].join(', ')}`,
    );
  }
  return value as PlanningThinkingLevel;
}
function parseAgent(value: unknown, location: string, filePath: string): PlanningAgentConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, AGENT_KEYS, location, filePath);
  const thinking = parseThinking(value.thinking, location, filePath);
  const model = optionalString(value.model, `${location}.model`, filePath);
  return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}
/**
 * A flag the cockpit can write.
 *
 * The settings page writes strings and nothing else, so `'true'` has to mean
 * what a hand-edited `true` means. Anything else is rejected rather than
 * treated as false, because a typo that silently disables a feature is the
 * worst reading of it.
 */
function parseFlexibleBoolean(value: unknown, location: string, filePath: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Doom config at ${filePath} requires ${location} to be true or false`);
}
/** Same story as the flag: a number, or the string form the settings page writes. */
function parseFlexibleRatio(value: unknown, location: string, filePath: string): number | undefined {
  if (value === undefined) return undefined;
  const ratio = typeof value === 'string' ? Number(value.trim()) : value;
  if (
    typeof ratio !== 'number' ||
    !Number.isFinite(ratio) ||
    ratio < MIN_AUTOCOMPACT_RATIO ||
    ratio > MAX_AUTOCOMPACT_RATIO
  ) {
    throw new Error(
      `Doom config at ${filePath} requires ${location} to be a number from ${MIN_AUTOCOMPACT_RATIO} to ${MAX_AUTOCOMPACT_RATIO}`,
    );
  }
  return ratio;
}
function parseAutocompactThresholds(
  value: unknown,
  location: string,
  filePath: string,
): AutocompactThresholdConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, AUTOCOMPACT_THRESHOLD_KEYS, location, filePath);
  const pass1 = parseFlexibleRatio(value.pass1, `${location}.pass1`, filePath);
  const pass2 = parseFlexibleRatio(value.pass2, `${location}.pass2`, filePath);
  const pass3 = parseFlexibleRatio(value.pass3, `${location}.pass3`, filePath);
  return {
    ...(pass1 === undefined ? {} : { pass1 }),
    ...(pass2 === undefined ? {} : { pass2 }),
    ...(pass3 === undefined ? {} : { pass3 }),
  };
}
/** Absolute token counts, unlike the ratios, are only ever written by hand, so no string form is accepted. */
function parseAutocompactTokenCount(value: unknown, location: string, filePath: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_AUTOCOMPACT_TOKENS)
    throw new Error(
      `Doom config at ${filePath} requires ${location} to be an integer of at least ${MIN_AUTOCOMPACT_TOKENS}`,
    );
  return value;
}
function parseAutocompactOverrideEntry(value: unknown, location: string, filePath: string): AutocompactOverrideConfig {
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, AUTOCOMPACT_OVERRIDE_KEYS, location, filePath);
  const model = optionalString(value.model, `${location}.model`, filePath);
  if (!model) throw new Error(`Doom config at ${filePath} requires ${location}.model`);
  if (!isObject(value.tokens))
    throw new Error(`Doom config at ${filePath} requires ${location}.tokens to be an object`);
  assertKeys(value.tokens, AUTOCOMPACT_THRESHOLD_KEYS, `${location}.tokens`, filePath);
  const pass1 = parseAutocompactTokenCount(value.tokens.pass1, `${location}.tokens.pass1`, filePath);
  const pass2 = parseAutocompactTokenCount(value.tokens.pass2, `${location}.tokens.pass2`, filePath);
  const pass3 = parseAutocompactTokenCount(value.tokens.pass3, `${location}.tokens.pass3`, filePath);
  // An entry that pins nothing is a typo rather than a way to say "leave this model alone":
  // omitting the entry already does that, and a silent no-op reads like the override worked.
  if (pass1 === undefined && pass2 === undefined && pass3 === undefined)
    throw new Error(`Doom config at ${filePath} requires one of ${location}.tokens.pass1, pass2, or pass3`);
  return {
    model,
    tokens: {
      ...(pass1 === undefined ? {} : { pass1 }),
      ...(pass2 === undefined ? {} : { pass2 }),
      ...(pass3 === undefined ? {} : { pass3 }),
    },
  };
}
function parseAutocompactOverrides(
  value: unknown,
  location: string,
  filePath: string,
): AutocompactOverrideConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be a list`);
  return value.map((entry, index) => parseAutocompactOverrideEntry(entry, `${location}[${index}]`, filePath));
}
export function parseAutocompactModeConfig(
  value: unknown,
  filePath: string,
  location = 'modes.autocompact',
): AutocompactModeConfig {
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, AUTOCOMPACT_KEYS, location, filePath);
  const enabled = parseFlexibleBoolean(value.enabled, `${location}.enabled`, filePath);
  const model = optionalString(value.model, `${location}.model`, filePath);
  const thinking = parseThinking(value.thinking, location, filePath);
  const thresholds = parseAutocompactThresholds(value.thresholds, `${location}.thresholds`, filePath);
  const overrides = parseAutocompactOverrides(value.overrides, `${location}.overrides`, filePath);
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(thresholds ? { thresholds } : {}),
    ...(overrides ? { overrides } : {}),
  };
}
export function parsePlanningModeConfig(
  value: unknown,
  filePath: string,
  location = 'modes.planning',
): PlanningModeConfig {
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, PLANNING_KEYS, location, filePath);
  return {
    main: parseAgent(value.main, `${location}.main`, filePath),
    subagents: parseAgent(value.subagents, `${location}.subagents`, filePath),
    plansDirectory: optionalString(value.plansDirectory, `${location}.plansDirectory`, filePath),
  };
}
function parseModel(value: unknown, location: string, filePath: string, allowId: boolean): VoiceModelConfig {
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, MODEL_KEYS, location, filePath);
  const modelPath = optionalString(value.path, `${location}.path`, filePath);
  const id = optionalString(value.id, `${location}.id`, filePath);
  if (Boolean(modelPath) === Boolean(id))
    throw new Error(`Doom config at ${filePath} requires exactly one of ${location}.path or ${location}.id`);
  if (id && !allowId) throw new Error(`Doom config at ${filePath} does not support ${location}.id for whisper-cpp`);
  return { ...(modelPath ? { path: modelPath } : {}), ...(id ? { id } : {}) };
}
function parseAdapter(
  value: unknown,
  location: string,
  filePath: string,
  allowId: boolean,
): VoiceAdapterConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, ADAPTER_KEYS, location, filePath);
  const binary = optionalString(value.binary, `${location}.binary`, filePath);
  return { ...(binary ? { binary } : {}), model: parseModel(value.model, `${location}.model`, filePath, allowId) };
}
function parseVoice(value: unknown, filePath: string): VoiceConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires voice to be an object`);
  assertKeys(value, VOICE_KEYS, 'voice', filePath);
  const result: VoiceConfig = {};
  if (value.mode !== undefined) {
    if (typeof value.mode !== 'string' || !VOICE_MODE_VALUES.has(value.mode as VoiceMode))
      throw new Error(
        `Doom config at ${filePath} requires voice.mode to be one of: ${[...VOICE_MODE_VALUES].join(', ')}`,
      );
    result.mode = value.mode as VoiceMode;
  }
  if (value.engine !== undefined) {
    if (typeof value.engine !== 'string' || !ENGINE_VALUES.has(value.engine as VoiceEngine))
      throw new Error(
        `Doom config at ${filePath} requires voice.engine to be one of: ${[...ENGINE_VALUES].join(', ')}`,
      );
    result.engine = value.engine as VoiceEngine;
  }
  const language = optionalString(value.language, 'voice.language', filePath);
  if (language) result.language = language;
  if (value.recorder !== undefined) {
    if (!isObject(value.recorder))
      throw new Error(`Doom config at ${filePath} requires voice.recorder to be an object`);
    assertKeys(value.recorder, RECORDER_KEYS, 'voice.recorder', filePath);
    result.recorder = {};
    const binary = optionalString(value.recorder.binary, 'voice.recorder.binary', filePath);
    const device = optionalString(value.recorder.device, 'voice.recorder.device', filePath);
    if (binary) result.recorder.binary = binary;
    if (device) result.recorder.device = device;
  }
  if (value.adapters !== undefined) {
    if (!isObject(value.adapters))
      throw new Error(`Doom config at ${filePath} requires voice.adapters to be an object`);
    assertKeys(value.adapters, ADAPTERS_KEYS, 'voice.adapters', filePath);
    result.adapters = {
      [WHISPER_CPP_ENGINE]: parseAdapter(
        value.adapters[WHISPER_CPP_ENGINE],
        `voice.adapters.${WHISPER_CPP_ENGINE}`,
        filePath,
        false,
      ),
      [OPENAI_WHISPER_ENGINE]: parseAdapter(
        value.adapters[OPENAI_WHISPER_ENGINE],
        `voice.adapters.${OPENAI_WHISPER_ENGINE}`,
        filePath,
        true,
      ),
      [MLX_WHISPER_ENGINE]: parseAdapter(
        value.adapters[MLX_WHISPER_ENGINE],
        `voice.adapters.${MLX_WHISPER_ENGINE}`,
        filePath,
        true,
      ),
    };
  }
  const autoCapture = parseAutoCapture(value.autoCapture, filePath);
  if (autoCapture) result.autoCapture = autoCapture;
  return result;
}
function parseSelection(value: unknown, filePath: string): DoomSelectionConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires selection to be an object`);
  assertKeys(value, SELECTION_KEYS, 'selection', filePath);
  const domains = value.domains;
  if (domains !== undefined && (!Array.isArray(domains) || domains.some((name) => typeof name !== 'string'))) {
    throw new Error(`Doom config at ${filePath} requires selection.domains to be an array of strings`);
  }
  return {
    majorMode: optionalString(value.majorMode, 'selection.majorMode', filePath),
    // An empty list is meaningful: it selects no content domains at all.
    domains: domains as string[] | undefined,
    profile: optionalString(value.profile, 'selection.profile', filePath),
  };
}
function parseEditor(value: unknown, filePath: string): EditorConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires editor to be an object`);
  assertKeys(value, EDITOR_KEYS, 'editor', filePath);
  return { command: optionalString(value.command, 'editor.command', filePath) };
}

function parseComputerUse(value: unknown, filePath: string): ComputerUseConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires computerUse to be an object`);
  assertKeys(value, COMPUTER_USE_KEYS, 'computerUse', filePath);
  const enabled = parseFlexibleBoolean(value.enabled, 'computerUse.enabled', filePath);
  return enabled === undefined ? {} : { enabled };
}
/**
 * Reads one Doom config file.
 *
 * The two-argument form is the strict contract every harness-launch consumer
 * relies on: an unknown key is a hard error. `doompi sync` opts into the
 * lenient form so a config written for a different version cannot break a
 * build; `doompi doctor` is the strict check that still reports those keys.
 * Invalid values for known keys throw in both modes.
 */
export function parseDoomConfig(content: string, filePath: string): DoomConfig;
export function parseDoomConfig(content: string, filePath: string, options: LenientParseOptions): LenientParseResult;
export function parseDoomConfig(
  content: string,
  filePath: string,
  options?: LenientParseOptions,
): DoomConfig | LenientParseResult {
  if (options?.lenient !== true) return parseStrict(content, filePath);
  const diagnostics: ConfigDiagnostic[] = [];
  const previous = unknownKeySink;
  unknownKeySink = diagnostics;
  try {
    return { config: parseStrict(content, filePath), diagnostics };
  } finally {
    unknownKeySink = previous;
  }
}

function parseStrict(content: string, filePath: string): DoomConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(content) ?? {};
  } catch (error) {
    throw new Error(`Could not parse Doom config at ${filePath}`, { cause: error });
  }
  if (!isObject(parsed)) throw new Error(`Doom config at ${filePath} must be a YAML object`);
  assertKeys(parsed, ROOT_KEYS, 'root', filePath);
  let modes: DoomConfig['modes'];
  if (parsed.modes !== undefined) {
    if (!isObject(parsed.modes)) throw new Error(`Doom config at ${filePath} requires modes to be an object`);
    assertKeys(parsed.modes, MODE_KEYS, 'modes', filePath);
    modes = {
      ...(parsed.modes.planning === undefined
        ? {}
        : { planning: parsePlanningModeConfig(parsed.modes.planning, filePath) }),
      ...(parsed.modes.autocompact === undefined
        ? {}
        : { autocompact: parseAutocompactModeConfig(parsed.modes.autocompact, filePath) }),
    };
  }
  const trust = parsed.projectTrust === undefined ? DEFAULT_PROJECT_TRUST : parsed.projectTrust;
  if (typeof trust !== 'string' || !TRUST_VALUES.has(trust as ProjectTrust))
    throw new Error(`Doom config at ${filePath} projectTrust must be ask, always, or never`);
  return {
    modes,
    computerUse: parseComputerUse(parsed.computerUse, filePath),
    projectTrust: trust as ProjectTrust,
    editor: parseEditor(parsed.editor, filePath),
    voice: parseVoice(parsed.voice, filePath),
    selection: parseSelection(parsed.selection, filePath),
  };
}
function mergeAgent(
  globalValue?: PlanningAgentConfig,
  repositoryValue?: PlanningAgentConfig,
): PlanningAgentConfig | undefined {
  return globalValue || repositoryValue ? { ...globalValue, ...repositoryValue } : undefined;
}
export function mergeDoomConfigs(globalConfig: DoomConfig, repositoryConfig: DoomConfig): DoomConfig {
  if (repositoryConfig.voice?.mode)
    throw new Error('Repository Doom config voice.mode is global-only; configure it in ~/.pi/.doom/config.yaml');
  if (repositoryConfig.voice?.autoCapture)
    throw new Error('Repository Doom config voice.autoCapture is global-only; configure it in ~/.pi/.doom/config.yaml');
  if (repositoryConfig.computerUse)
    throw new Error('Repository Doom config computerUse is global-only; configure it in ~/.pi/.doom/config.yaml');
  const globalPlanning = globalConfig.modes?.planning;
  const repositoryPlanning = repositoryConfig.modes?.planning;
  const planning =
    globalPlanning || repositoryPlanning
      ? {
          main: mergeAgent(globalPlanning?.main, repositoryPlanning?.main),
          subagents: mergeAgent(globalPlanning?.subagents, repositoryPlanning?.subagents),
          plansDirectory: repositoryPlanning?.plansDirectory ?? globalPlanning?.plansDirectory,
        }
      : undefined;
  const globalAutocompact = globalConfig.modes?.autocompact;
  const repositoryAutocompact = repositoryConfig.modes?.autocompact;
  // Per key, so a repository can pin the model and inherit the ladder, or the
  // other way round. `overrides` is deliberately not merged that way: the spread
  // below lets a repository list replace the global one whole, because the rules
  // are first-match-wins and interleaving two files a reader cannot see together
  // would decide precedence somewhere neither of them says.
  const autocompact =
    globalAutocompact || repositoryAutocompact
      ? {
          ...globalAutocompact,
          ...repositoryAutocompact,
          ...(globalAutocompact?.thresholds || repositoryAutocompact?.thresholds
            ? { thresholds: { ...globalAutocompact?.thresholds, ...repositoryAutocompact?.thresholds } }
            : {}),
        }
      : undefined;
  const voice = mergeVoice(globalConfig.voice, repositoryConfig.voice);
  return {
    modes:
      planning || autocompact
        ? { ...(planning ? { planning } : {}), ...(autocompact ? { autocompact } : {}) }
        : undefined,
    computerUse: globalConfig.computerUse,
    projectTrust: repositoryConfig.projectTrust,
    editor: globalConfig.editor,
    voice,
    // Per key, so a repository can pin one axis and inherit the rest.
    selection:
      globalConfig.selection || repositoryConfig.selection
        ? { ...globalConfig.selection, ...repositoryConfig.selection }
        : undefined,
  };
}
function mergeAdapter(
  globalValue?: VoiceAdapterConfig,
  repositoryValue?: VoiceAdapterConfig,
): VoiceAdapterConfig | undefined {
  if (!globalValue && !repositoryValue) return undefined;
  return { ...globalValue, ...repositoryValue, model: repositoryValue?.model ?? globalValue!.model };
}
function mergeVoice(globalValue?: VoiceConfig, repositoryValue?: VoiceConfig): VoiceConfig | undefined {
  if (!globalValue && !repositoryValue) return undefined;
  return {
    ...globalValue,
    ...repositoryValue,
    ...(globalValue?.mode ? { mode: globalValue.mode } : {}),
    recorder:
      globalValue?.recorder || repositoryValue?.recorder
        ? { ...globalValue?.recorder, ...repositoryValue?.recorder }
        : undefined,
    adapters:
      globalValue?.adapters || repositoryValue?.adapters
        ? {
            [WHISPER_CPP_ENGINE]: mergeAdapter(
              globalValue?.adapters?.[WHISPER_CPP_ENGINE],
              repositoryValue?.adapters?.[WHISPER_CPP_ENGINE],
            ),
            [OPENAI_WHISPER_ENGINE]: mergeAdapter(
              globalValue?.adapters?.[OPENAI_WHISPER_ENGINE],
              repositoryValue?.adapters?.[OPENAI_WHISPER_ENGINE],
            ),
            [MLX_WHISPER_ENGINE]: mergeAdapter(
              globalValue?.adapters?.[MLX_WHISPER_ENGINE],
              repositoryValue?.adapters?.[MLX_WHISPER_ENGINE],
            ),
          }
        : undefined,
    ...(globalValue?.autoCapture ? { autoCapture: globalValue.autoCapture } : {}),
  };
}
/**
 * Resolves voice settings, optionally shadowed by the active profile's override.
 *
 * The override is per field, so a persona that sets only `rate` keeps the voice
 * from config.yaml. `engine` is deliberately not overridable: it selects the
 * synthesiser binary, which is a machine-level fact rather than a persona's.
 *
 * The result is read once when autonomous voice activates, because
 * `VoiceNarrationPlayback.config` is assigned in `activate()` and has no setter.
 * That is sufficient today only because every profile switch reloads the
 * session, which deactivates and reactivates voice. A future in-place profile
 * switch would leave the spoken voice stale until the next activation.
 */
export function resolveVoiceConfig(config: VoiceConfig, ttsOverride?: PersonaVoiceOverride): ResolvedVoiceConfig {
  return {
    mode: config.mode ?? DEFAULT_VOICE_MODE,
    engine: config.engine ?? DEFAULT_VOICE_ENGINE,
    language: config.language ?? DEFAULT_VOICE_LANGUAGE,
    recorder: { ...config.recorder, device: config.recorder?.device ?? DEFAULT_RECORDER_DEVICE },
    adapters: config.adapters ?? {},
    ...(config.autoCapture
      ? {
          autoCapture: {
            ...config.autoCapture,
            startPhrases: [...(config.autoCapture.startPhrases ?? [])],
            stopPhrases: [...(config.autoCapture.stopPhrases ?? [])],
            // Unlike start and stop phrases, these default to a non-empty list: without
            // a send phrase a draft could be opened and never submitted.
            composeOpenPhrases: [...(config.autoCapture.composeOpenPhrases ?? DEFAULT_COMPOSE_OPEN_PHRASES)],
            composeSendPhrases: [...(config.autoCapture.composeSendPhrases ?? DEFAULT_COMPOSE_SEND_PHRASES)],
            composeCancelPhrases: [...(config.autoCapture.composeCancelPhrases ?? DEFAULT_COMPOSE_CANCEL_PHRASES)],
            utteranceIdleMs: config.autoCapture.utteranceIdleMs ?? DEFAULT_UTTERANCE_IDLE_MS,
            composeUtteranceIdleMs: config.autoCapture.composeUtteranceIdleMs ?? DEFAULT_COMPOSE_UTTERANCE_IDLE_MS,
            composeNudgeMs: config.autoCapture.composeNudgeMs ?? DEFAULT_COMPOSE_NUDGE_MS,
            transcriptionTimeoutMs: config.autoCapture.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
            tts: {
              ...config.autoCapture.tts,
              ...(ttsOverride?.voice === undefined ? {} : { voice: ttsOverride.voice }),
              ...(ttsOverride?.rate === undefined ? {} : { rate: ttsOverride.rate }),
            },
          },
        }
      : {}),
  };
}

/**
 * Which files a key may be written to.
 *
 * `mergeDoomConfigs` above already decides this per field, but it decides it by
 * doing it: `editor` reads only from the global side, `projectTrust` only from
 * the repository side, and repository `voice.mode` or `voice.autoCapture`
 * declarations throw outright. A caller holding a key path has no way to ask.
 * surface offers writes that throw, or worse, writes that land in a file the
 * merge will ignore, so the change appears to do nothing.
 *
 * Declared here rather than beside the writer because the rule is a property of
 * the merge, not of the filesystem, and a test asserts the two agree.
 */
export type ConfigKeyScope = 'global' | 'repository' | 'both';

/** Root keys the merge reads from one side only. */
const GLOBAL_ONLY_ROOTS: readonly string[] = ['computerUse', 'editor'];
const REPOSITORY_ONLY_ROOTS: readonly string[] = ['projectTrust'];
/** Nested exceptions; a repository declaration of either throws in the merge. */
const GLOBAL_ONLY_PATHS: readonly (readonly string[])[] = [
  ['voice', 'mode'],
  ['voice', 'autoCapture'],
];

function startsWith(keyPath: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= keyPath.length && prefix.every((segment, index) => keyPath[index] === segment);
}

/**
 * The scopes a key path accepts. An unknown root answers `both` rather than
 * throwing: the parser is what rejects unsupported keys, and it reports them
 * far better than a scope lookup could.
 */
export function configScopeOf(keyPath: readonly string[]): ConfigKeyScope {
  if (keyPath.length === 0) return 'both';
  if (GLOBAL_ONLY_PATHS.some((prefix) => startsWith(keyPath, prefix))) return 'global';
  const root = keyPath[0]!;
  if (GLOBAL_ONLY_ROOTS.includes(root)) return 'global';
  if (REPOSITORY_ONLY_ROOTS.includes(root)) return 'repository';
  return 'both';
}

/** Every root key the config accepts, so a caller can enumerate without importing the parser's internals. */
export function configRootKeys(): readonly string[] {
  return ROOT_KEYS;
}

const KEY_SEPARATOR = '.';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every key path a parsed document actually sets, as dotted strings.
 *
 * A settings surface needs to tell "this file set this key" from "this file is
 * silent about it", and the parsed `DoomConfig` cannot answer: an absent file
 * reads as `{ projectTrust: 'ask' }` and `parseDoomConfig` always returns all
 * five root keys, some undefined. So the question is asked of the raw document
 * instead, before any defaulting has happened.
 *
 * Leaves only. A list is a leaf because it is replaced whole, and an empty
 * record sets nothing.
 */
export function configLeafKeys(value: unknown, prefix: readonly string[] = []): string[] {
  if (!isPlainRecord(value)) return prefix.length > 0 ? [prefix.join(KEY_SEPARATOR)] : [];
  const keys = Object.keys(value);
  if (keys.length === 0) return prefix.length > 0 ? [prefix.join(KEY_SEPARATOR)] : [];
  return keys.flatMap((key) => configLeafKeys(value[key], [...prefix, key]));
}

/** The value a key path points at, or undefined when any step is missing. */
export function valueAtKeyPath(value: unknown, keyPath: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of keyPath) {
    if (!isPlainRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}
