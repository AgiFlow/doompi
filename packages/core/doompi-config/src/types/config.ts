import type { DoomMcpProjection } from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import type { IDoomConfigService as DoomConfigServiceContract } from '@agimon-ai/doompi-extension-contracts/config';

export { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';

export type ProjectTrust = 'ask' | 'always' | 'never';
export type PlanningThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type VoiceEngine = 'auto' | 'whisper-cpp' | 'openai-whisper' | 'mlx-whisper';
export type VoiceTtsEngine = 'macos-say';

export interface PlanningAgentConfig {
  model?: string;
  thinking?: PlanningThinkingLevel;
}
export interface PlanningModeConfig {
  main?: PlanningAgentConfig;
  subagents?: PlanningAgentConfig;
  plansDirectory?: string;
}
export interface EditorConfig {
  command?: string;
}
export interface VoiceModelConfig {
  path?: string;
  id?: string;
}
export interface VoiceAdapterConfig {
  binary?: string;
  model: VoiceModelConfig;
}
export interface VoiceTtsConfig {
  engine: VoiceTtsEngine;
  voice?: string;
  rate?: number;
}
export interface VoiceAutoCaptureConfig {
  model: string;
  startPhrases?: string[];
  stopPhrases?: string[];
  composeOpenPhrases?: string[];
  composeSendPhrases?: string[];
  composeCancelPhrases?: string[];
  utteranceIdleMs?: number;
  composeUtteranceIdleMs?: number;
  composeNudgeMs?: number;
  transcriptionTimeoutMs?: number;
  tts: VoiceTtsConfig;
}
export interface ResolvedVoiceAutoCaptureConfig {
  model: string;
  startPhrases: string[];
  stopPhrases: string[];
  composeOpenPhrases: string[];
  composeSendPhrases: string[];
  composeCancelPhrases: string[];
  utteranceIdleMs: number;
  composeUtteranceIdleMs: number;
  composeNudgeMs: number;
  transcriptionTimeoutMs?: number;
  tts: VoiceTtsConfig;
}
export interface VoiceConfig {
  engine?: VoiceEngine;
  language?: string;
  recorder?: { binary?: string; device?: string };
  adapters?: {
    'whisper-cpp'?: VoiceAdapterConfig;
    'openai-whisper'?: VoiceAdapterConfig;
    'mlx-whisper'?: VoiceAdapterConfig;
  };
  autoCapture?: VoiceAutoCaptureConfig;
}
export interface ResolvedVoiceConfig {
  engine: VoiceEngine;
  language: string;
  recorder: { binary?: string; device: string };
  adapters: NonNullable<VoiceConfig['adapters']>;
  autoCapture?: ResolvedVoiceAutoCaptureConfig;
}
/**
 * The matrix a repository selects by default.
 *
 * Read by `doom-pi sync`, which pins it into the generated Pi config so a plain
 * `pi` session starts on the same matrix the repository declares. The launcher
 * keeps taking its selection from flags and the environment.
 */
export interface DoomSelectionConfig {
  majorMode?: string;
  domains?: string[];
  profile?: string;
}

/** The selection persisted in a Pi session entry. */
export interface DoomConfigSelection {
  readonly version: 1;
  readonly majorMode: string;
  readonly domains: readonly string[];
  readonly profile?: string;
  /** Canonical identity of the parent/child extension composition. */
  readonly compositionFingerprint?: string;
}

export type DoomConfigTransitionStrategy = 'pi-reload' | 'process-relaunch';
export type DoomConfigTransitionPhase = 'pending' | 'applied' | 'aborted' | 'superseded';

export interface DoomConfigTransitionRecord {
  readonly version: 1;
  readonly operationId: string;
  readonly active: DoomConfigSelection;
  readonly target: DoomConfigSelection;
  readonly strategy: DoomConfigTransitionStrategy;
  readonly phase: DoomConfigTransitionPhase;
}

/** A transition journal target that has not yet received an explicit fresh-session acknowledgement. */
export type DoomConfigPendingSelection = DoomConfigTransitionRecord & { readonly phase: 'pending' };

export interface DoomConfig {
  modes?: { planning?: PlanningModeConfig };
  projectTrust: ProjectTrust;
  editor?: EditorConfig;
  voice?: VoiceConfig;
  selection?: DoomSelectionConfig;
}

export interface PluginHookSource {
  pluginRoot: string;
  configPath: string;
}

export interface HarnessState {
  root?: string;
  /** The one named major mode this session runs under. */
  majorMode: string;
  temporaryDirectory?: string;
  domains: string[];
  /** The layer components the major mode resolved to. */
  layers: string[];
  /** Canonical identity shared by launch, sync, children, and reload. */
  compositionFingerprint?: string;
  profile?: string;
  profileEnvironment: Record<string, string>;
  hookGroups?: string[];
  skillDirectories: string[];
  agentDirectories: string[];
  additionalDirectories: string[];
  childExtensions: string[];
  pluginDirectories: string[];
  pluginHooks: PluginHookSource[];
  /** File-only authority that the Config core publishes to the session registry. */
  mcpProjection?: DoomMcpProjection;
  mcpConfigPath?: string;
  personaFile?: string;
  allowProtectedWrites: boolean;
  hooks: boolean;
  agents: boolean;
  mcp: boolean;
}

export type DeepReadonly<TValue> = TValue extends (...args: never[]) => unknown
  ? TValue
  : TValue extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : TValue extends object
      ? { readonly [TKey in keyof TValue]: DeepReadonly<TValue[TKey]> }
      : TValue;

export type DoomHarnessContext = DeepReadonly<HarnessState>;

export interface DoomConfigContext {
  readonly settings: DeepReadonly<DoomConfig>;
  readonly harness: DoomHarnessContext;
  /** A journal target awaiting explicit acknowledgement; the active harness remains above. */
  readonly pendingSelection?: DeepReadonly<DoomConfigPendingSelection>;
  /** Whether the active harness does not yet match the pending target. */
  readonly requiresRelaunch: boolean;
}

/** A file-only loader; unlike the Cordis service it owns no live session snapshot. */
export interface IDoomConfigLoader {
  load(repoRoot: string, homeDirectory?: string): DoomConfig;
}

/** The config package's concrete specialization of the cross-package service contract. */
export interface IDoomConfigService extends DoomConfigServiceContract<DoomConfigContext, DoomConfig> {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/config': IDoomConfigService;
  }
}

/** Reads the merged Doom configuration. Supplied by the adapter layer. */
export type DoomConfigLoader = (repoRoot: string, homeDirectory?: string) => DoomConfig;
