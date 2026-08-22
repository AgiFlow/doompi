import { parse as parseYaml } from 'yaml';
import type {
  DoomConfig,
  DoomSelectionConfig,
  EditorConfig,
  PlanningAgentConfig,
  PlanningModeConfig,
  PlanningThinkingLevel,
  ProjectTrust,
  ResolvedVoiceConfig,
  VoiceAdapterConfig,
  VoiceAutoCaptureConfig,
  VoiceConfig,
  VoiceEngine,
  VoiceModelConfig,
  VoiceTtsConfig,
  VoiceTtsEngine,
} from '../types/config.ts';

const DEFAULT_PROJECT_TRUST: ProjectTrust = 'ask';
const DEFAULT_VOICE_ENGINE: VoiceEngine = 'auto';
const DEFAULT_VOICE_LANGUAGE = 'auto';
const DEFAULT_RECORDER_DEVICE = 'none:default';
const ROOT_KEYS = ['modes', 'projectTrust', 'editor', 'voice', 'selection'] as const;
const SELECTION_KEYS = ['majorMode', 'domains', 'profile'] as const;
const MODE_KEYS = ['planning'] as const;
const PLANNING_KEYS = ['main', 'subagents', 'plansDirectory'] as const;
const AGENT_KEYS = ['model', 'thinking'] as const;
const EDITOR_KEYS = ['command'] as const;
const VOICE_KEYS = ['engine', 'language', 'recorder', 'adapters', 'autoCapture'] as const;
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
  'utteranceIdleMs',
  'transcriptionTimeoutMs',
  'tts',
] as const;
const TTS_KEYS = ['engine', 'voice', 'rate'] as const;
const DEFAULT_UTTERANCE_IDLE_MS = 3_000;
const MIN_UTTERANCE_IDLE_MS = 1_500;
const MAX_UTTERANCE_IDLE_MS = 10_000;
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
export const DOOM_VOICE_ENGINES = [
  DEFAULT_VOICE_ENGINE,
  WHISPER_CPP_ENGINE,
  OPENAI_WHISPER_ENGINE,
  MLX_WHISPER_ENGINE,
] as const;
export const DOOM_VOICE_TTS_ENGINES = [MACOS_SAY_TTS_ENGINE] as const;

const THINKING_VALUES = new Set<PlanningThinkingLevel>(DOOM_PLANNING_THINKING_LEVELS);
const TRUST_VALUES = new Set<ProjectTrust>(['ask', 'always', 'never']);
const ENGINE_VALUES = new Set<VoiceEngine>(DOOM_VOICE_ENGINES);
const TTS_ENGINE_VALUES = new Set<VoiceTtsEngine>(DOOM_VOICE_TTS_ENGINES);
type ConfigObject = Record<string, unknown>;

function isObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertKeys(value: ConfigObject, allowed: readonly string[], location: string, filePath: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
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
  const utteranceIdleMs = value.utteranceIdleMs;
  if (
    utteranceIdleMs !== undefined &&
    (typeof utteranceIdleMs !== 'number' ||
      !Number.isInteger(utteranceIdleMs) ||
      utteranceIdleMs < MIN_UTTERANCE_IDLE_MS ||
      utteranceIdleMs > MAX_UTTERANCE_IDLE_MS)
  ) {
    throw new Error(
      `Doom config at ${filePath} requires ${location}.utteranceIdleMs to be an integer from ${MIN_UTTERANCE_IDLE_MS} to ${MAX_UTTERANCE_IDLE_MS}`,
    );
  }
  const transcriptionTimeoutMs = value.transcriptionTimeoutMs;
  if (
    transcriptionTimeoutMs !== undefined &&
    (typeof transcriptionTimeoutMs !== 'number' ||
      !Number.isInteger(transcriptionTimeoutMs) ||
      transcriptionTimeoutMs < MIN_TRANSCRIPTION_TIMEOUT_MS ||
      transcriptionTimeoutMs > MAX_TRANSCRIPTION_TIMEOUT_MS)
  ) {
    throw new Error(
      `Doom config at ${filePath} requires ${location}.transcriptionTimeoutMs to be an integer from ${MIN_TRANSCRIPTION_TIMEOUT_MS} to ${MAX_TRANSCRIPTION_TIMEOUT_MS}`,
    );
  }
  const startKeys = new Set((startPhrases ?? []).map(normalizeControlPhrase));
  if ((stopPhrases ?? []).some((phrase) => startKeys.has(normalizeControlPhrase(phrase))))
    throw new Error(`Doom config at ${filePath} does not allow a phrase in both startPhrases and stopPhrases`);
  return {
    model: parseModelReference(value.model, filePath),
    ...(startPhrases ? { startPhrases } : {}),
    ...(stopPhrases ? { stopPhrases } : {}),
    ...(utteranceIdleMs === undefined ? {} : { utteranceIdleMs }),
    ...(transcriptionTimeoutMs === undefined ? {} : { transcriptionTimeoutMs }),
    tts: parseTtsConfig(value.tts, filePath),
  };
}
function parseAgent(value: unknown, location: string, filePath: string): PlanningAgentConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Doom config at ${filePath} requires ${location} to be an object`);
  assertKeys(value, AGENT_KEYS, location, filePath);
  const thinking = value.thinking;
  if (
    thinking !== undefined &&
    (typeof thinking !== 'string' || !THINKING_VALUES.has(thinking as PlanningThinkingLevel))
  ) {
    throw new Error(
      `Doom config at ${filePath} requires ${location}.thinking to be one of: ${[...THINKING_VALUES].join(', ')}`,
    );
  }
  const model = optionalString(value.model, `${location}.model`, filePath);
  return { ...(model ? { model } : {}), ...(thinking ? { thinking: thinking as PlanningThinkingLevel } : {}) };
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
export function parseDoomConfig(content: string, filePath: string): DoomConfig {
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
    modes =
      parsed.modes.planning === undefined ? {} : { planning: parsePlanningModeConfig(parsed.modes.planning, filePath) };
  }
  const trust = parsed.projectTrust === undefined ? DEFAULT_PROJECT_TRUST : parsed.projectTrust;
  if (typeof trust !== 'string' || !TRUST_VALUES.has(trust as ProjectTrust))
    throw new Error(`Doom config at ${filePath} projectTrust must be ask, always, or never`);
  return {
    modes,
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
  if (repositoryConfig.voice?.autoCapture)
    throw new Error('Repository Doom config voice.autoCapture is global-only; configure it in ~/.pi/.doom/config.yaml');
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
  const voice = mergeVoice(globalConfig.voice, repositoryConfig.voice);
  return {
    modes: planning ? { planning } : undefined,
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
export function resolveVoiceConfig(config: VoiceConfig): ResolvedVoiceConfig {
  return {
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
            utteranceIdleMs: config.autoCapture.utteranceIdleMs ?? DEFAULT_UTTERANCE_IDLE_MS,
            transcriptionTimeoutMs: config.autoCapture.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
            tts: { ...config.autoCapture.tts },
          },
        }
      : {}),
  };
}
