/**
 * Voice's slice of the `SPC e c` config panel, and the installer behind it.
 *
 * Picking a model is the whole interaction: enter on an entry either selects it,
 * if everything it needs is already present, or shows exactly which commands
 * would be run and installs it once confirmed. The engine follows from the model
 * rather than being chosen separately, because choosing an engine with no model
 * installed is a state a user can only get out of by choosing a model anyway.
 *
 * The panel never blocks on any of this: an install runs on its own and reports
 * through republished sections, so closing the panel does not stop it and
 * reopening shows where it got to.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalDoomConfigDirectory, globalDoomConfigPath } from '@agimon-ai/doompi-config/config';
import { type DoomConfigEdit, writeDoomConfigValues } from '@agimon-ai/doompi-config/configWriter';
import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config/types';
import {
  CONFIG_ACTION,
  type ConfigChoice,
  type ConfigSection,
  type ConfigStep,
} from '@agimon-ai/doompi-extension-contracts/config';
import {
  catalogEntryById,
  ENGINE_TOOLING,
  engineGroupLabel,
  formatBytes,
  VOICE_CATALOG,
  type VoiceCatalogEntry,
} from '../../services/catalog.ts';
import type { IExecutableResolver, IProcessSpawner } from '../../types/index.ts';
import {
  downloadModelFile,
  ensureModelsDirectory,
  type FetchLike,
  isDownloaded,
  modelsDirectory,
} from '../audio/download.ts';
import { type InstallPlan, type InstallStep, planBlocker, planInstall } from '../audio/install.ts';

export const VOICE_CONFIG_SECTION_ID = 'voice';
const SECTION_ORDER = 10;
const FIELD_ENGINE = 'engine';
const FIELD_MODEL = 'model';
const FIELD_LANGUAGE = 'language';
const FIELD_DEVICE = 'recorder.device';
const FIELD_AUTO_MODEL = 'autoCapture.model';
const FIELD_AUTO_START = 'autoCapture.startPhrases';
const FIELD_AUTO_STOP = 'autoCapture.stopPhrases';
const FIELD_AUTO_IDLE = 'autoCapture.utteranceIdleMs';
const FIELD_TTS_ENGINE = 'autoCapture.tts.engine';
const FIELD_TTS_VOICE = 'autoCapture.tts.voice';
const FIELD_TTS_RATE = 'autoCapture.tts.rate';
/** How a phrase list is written and read back in a single-line field. */
const PHRASE_SEPARATOR = ', ';
const PHRASE_SPLIT = /\s*,\s*/;
/** `VoiceTtsEngine` is a single literal today; a choice list keeps it discoverable. */
const TTS_ENGINE_CHOICES = [{ id: 'macos-say', label: 'macos-say', detail: 'macOS `say`', action: CONFIG_ACTION.set }];
/** Clearing the language is what `auto` means in the file, so the entry clears. */
const LANGUAGE_AUTO_ID = 'auto';
/**
 * The languages offered in the panel.
 *
 * A transcriber accepts far more than this; a list of ninety is a worse way to
 * pick one than typing it. These are the common ones, and the file still takes
 * any code the engine knows.
 */
const LANGUAGE_CHOICES: readonly (readonly [string, string])[] = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ru', 'Russian'],
  ['zh', 'Chinese'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['vi', 'Vietnamese'],
  ['th', 'Thai'],
  ['hi', 'Hindi'],
  ['ar', 'Arabic'],
  ['tr', 'Turkish'],
  ['pl', 'Polish'],
  ['uk', 'Ukrainian'],
  ['id', 'Indonesian'],
];
const ACTION_INSTALL = 'install';
const ACTION_SELECT = 'select';
const ACTION_CONFIRM = 'confirm';
const ACTION_CANCEL = 'cancel';
const ACTION_ABORT = 'abort';
const ACTION_INPUT = 'input';
const VOICE_PATH = ['voice'] as const;
/** The contract's caps, applied here so an overlong label cannot fail a snapshot. */
const MAX_DETAIL_LENGTH = 240;
const MAX_STEPS = 24;
const MAX_STEP_LABEL = 96;
const MAX_STEP_DETAIL = 160;

export interface VoiceConfigDeps {
  resolver: IExecutableResolver;
  spawner: IProcessSpawner;
  loadVoice: () => ResolvedVoiceConfig | undefined;
  /**
   * Runs a command on a terminal the user can watch and type into. Absent in
   * tests and whenever doom-runner is not installed, in which case an install
   * that needs to run a command says so rather than running one blind.
   */
  runCommand?: (options: {
    id: string;
    name: string;
    command: string;
    cwd: string;
  }) => Promise<VoiceConfigCommandHandle>;
  cwd?: () => string;
  fetchImpl?: FetchLike;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  /** Reports the running step so it is visible with the panel closed. */
  onStatus?: (text: string | undefined) => void;
  /**
   * Models this session can reach, offered for the hands-free model rather than
   * typed from memory. Absent in a context with no registry, where the field
   * falls back to free text.
   */
  listModels?: () => readonly { provider: string; id: string }[];
}

/** Optional interactive command seam supplied by a host that owns a terminal. */
export interface VoiceConfigCommandHandle {
  readonly completion: Promise<number>;
  tail(): readonly string[];
  awaitingInput(): boolean;
  answer(text: string): void;
  stop(): void;
}

/** `resolve` throws when a binary is absent; the panel needs a question, not an exception. */
function findBinary(resolver: IExecutableResolver, binary: string): string | undefined {
  try {
    return resolver.resolve(undefined, binary);
  } catch {
    return undefined;
  }
}

/**
 * Directories pip drops console scripts into that are routinely not on PATH.
 *
 * A `pip3 install` succeeds and still leaves `mlx_whisper` unrunnable, because
 * macOS user installs land in `~/Library/Python/<version>/bin` which nothing
 * adds to PATH by default. Finding it here and writing the absolute path into
 * the adapter's `binary` is what makes the install actually finish the job.
 */
function pythonScriptDirectories(homeDirectory: string): string[] {
  const pythonRoot = path.join(homeDirectory, 'Library', 'Python');
  let versioned: string[] = [];
  try {
    versioned = fs
      .readdirSync(pythonRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(pythonRoot, entry.name, 'bin'));
  } catch {
    versioned = [];
  }
  return [...versioned, path.join(homeDirectory, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

function locateBinary(resolver: IExecutableResolver, binary: string, homeDirectory: string): string | undefined {
  const onPath = findBinary(resolver, binary);
  if (onPath) return onPath;
  for (const directory of pythonScriptDirectories(homeDirectory)) {
    const candidate = path.join(directory, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') continue;
      throw error;
    }
  }
  return undefined;
}

function modelTargetPath(entry: VoiceCatalogEntry, configDirectory: string): string | undefined {
  return entry.download ? path.join(modelsDirectory(configDirectory), entry.download.fileName) : undefined;
}

interface InstallState {
  entryId: string;
  plan: InstallPlan;
  phase: 'confirming' | 'running';
  progress?: { label: string; ratio?: number };
  controller?: AbortController;
  /** The terminal the current command is running on, when one is. */
  pty?: VoiceConfigCommandHandle;
}

/** Every field the panel writes straight through, and where each one lives. */
const SIMPLE_FIELD_PATHS: Readonly<Record<string, readonly string[]>> = {
  [FIELD_LANGUAGE]: [...VOICE_PATH, 'language'],
  [FIELD_DEVICE]: [...VOICE_PATH, 'recorder', 'device'],
  [FIELD_AUTO_MODEL]: [...VOICE_PATH, 'autoCapture', 'model'],
  [FIELD_AUTO_START]: [...VOICE_PATH, 'autoCapture', 'startPhrases'],
  [FIELD_AUTO_STOP]: [...VOICE_PATH, 'autoCapture', 'stopPhrases'],
  [FIELD_AUTO_IDLE]: [...VOICE_PATH, 'autoCapture', 'utteranceIdleMs'],
  [FIELD_TTS_ENGINE]: [...VOICE_PATH, 'autoCapture', 'tts', 'engine'],
  [FIELD_TTS_VOICE]: [...VOICE_PATH, 'autoCapture', 'tts', 'voice'],
  [FIELD_TTS_RATE]: [...VOICE_PATH, 'autoCapture', 'tts', 'rate'],
};
const LIST_FIELDS = new Set<string>([FIELD_AUTO_START, FIELD_AUTO_STOP]);
const AUTO_CAPTURE_PATH = [...VOICE_PATH, 'autoCapture'] as const;
const TTS_ENGINE_PATH = [...AUTO_CAPTURE_PATH, 'tts', 'engine'] as const;
const DEFAULT_TTS_ENGINE = 'macos-say';
const AUTO_CAPTURE_FIELDS = new Set<string>([
  FIELD_AUTO_MODEL,
  FIELD_AUTO_START,
  FIELD_AUTO_STOP,
  FIELD_AUTO_IDLE,
  FIELD_TTS_ENGINE,
  FIELD_TTS_VOICE,
  FIELD_TTS_RATE,
]);
const NUMBER_FIELDS = new Set<string>([FIELD_AUTO_IDLE, FIELD_TTS_RATE]);

/**
 * The panel edits single-line text, while the config file holds lists and
 * numbers. A phrase list splits on commas; a number stays a string when it is
 * not one, which the caller reports rather than writing.
 */
export function parseFieldValue(fieldId: string, value: string): string | string[] | number {
  if (LIST_FIELDS.has(fieldId)) return value.split(PHRASE_SPLIT).filter(Boolean);
  if (!NUMBER_FIELDS.has(fieldId)) return value;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : value;
}

export class VoiceConfigController {
  private install: InstallState | undefined;
  private notice: string | undefined;
  private installedIds = new Set<string>();
  private readonly configDirectory: string;
  private readonly configPath: string;
  private readonly homeDirectory: string;

  constructor(
    private readonly deps: VoiceConfigDeps,
    private readonly republish: () => void,
  ) {
    this.configDirectory = globalDoomConfigDirectory(deps.homeDirectory);
    this.configPath = globalDoomConfigPath(deps.homeDirectory);
    this.homeDirectory = deps.homeDirectory ?? os.homedir();
  }

  /** Re-checks what is on disk. Cheap enough to run on session start and after a write. */
  async refresh(): Promise<void> {
    const availableBinaries = new Map<string, boolean>();
    const present = await Promise.all(
      VOICE_CATALOG.map(async (entry): Promise<string | undefined> => {
        const target = modelTargetPath(entry, this.configDirectory);
        if (target) {
          return (await isDownloaded(target, entry.sizeBytes)) ? entry.id : undefined;
        }
        // Nothing to download, so the tool being present is the whole requirement.
        // Located rather than just PATH-resolved: pip drops scripts in directories
        // nothing adds to PATH, and reporting those as missing would offer to
        // install something that is already there.
        const binary = ENGINE_TOOLING[entry.engine].binary;
        let available = availableBinaries.get(binary);
        if (available === undefined) {
          available = locateBinary(this.deps.resolver, binary, this.homeDirectory) !== undefined;
          availableBinaries.set(binary, available);
        }
        return available ? entry.id : undefined;
      }),
    );
    this.installedIds = new Set(present.filter((entry): entry is string => entry !== undefined));
  }

  sections(): readonly ConfigSection[] {
    const voice = this.safeLoad();
    const activeEngine = voice?.engine;
    const activeModel = this.activeModelId(voice);
    const installing = this.install;
    const modelField = installing?.phase === 'running' ? installing : undefined;

    const choices: ConfigChoice[] = VOICE_CATALOG.map((entry) => {
      const installed = this.installedIds.has(entry.id);
      const size = formatBytes(entry.sizeBytes);
      return {
        id: entry.id,
        label: entry.label,
        group: engineGroupLabel(entry.engine),
        ...(size ? { detail: size } : {}),
        status: installed ? ('ready' as const) : ('available' as const),
        statusText: installed
          ? entry.id === activeModel
            ? 'in use'
            : 'installed'
          : entry.download
            ? 'download'
            : 'install',
        action: installed ? ACTION_SELECT : ACTION_INSTALL,
      };
    });

    const auto = voice?.autoCapture;
    // Offered rather than typed: a model spec is `provider/id`, and typing one
    // from memory is how the setting ends up naming a model that is not there.
    const modelChoices: ConfigChoice[] = (this.deps.listModels?.() ?? []).map((model) => ({
      id: `${model.provider}/${model.id}`,
      label: model.id,
      group: model.provider,
      detail: model.provider,
      action: CONFIG_ACTION.set,
    }));
    return [
      {
        id: VOICE_CONFIG_SECTION_ID,
        title: 'voice',
        order: SECTION_ORDER,
        detail: this.readiness(voice),
        ...(this.notice ? { notice: this.notice, noticeLevel: 'error' as const } : {}),
        fields: [
          {
            id: FIELD_MODEL,
            label: 'model',
            kind: 'choice',
            keyPath: `voice.adapters.<engine>.model`,
            placeholder: 'not set',
            detail: 'enter installs what is missing, or switches to it when it is already there.',
            choices,
            ...(activeModel ? { value: activeModel } : {}),
            ...(modelField ? { busy: true, steps: planSteps(modelField) } : {}),
            ...(modelField?.progress ? { progress: modelField.progress } : {}),
            // The tail of the running command, and whether it is sitting on a
            // question, so the panel can offer a line to answer it.
            ...(modelField?.pty ? { output: [...modelField.pty.tail()] } : {}),
            ...(modelField?.pty?.awaitingInput() ? { awaitingInput: true } : {}),
            // The command list goes in `detail`, which the panel wraps under the
            // row. Right-aligning it as a status ran it off the edge of the pane.
            ...(installing?.phase === 'confirming'
              ? {
                  detail: confirmSummary(installing.plan),
                  actions: [
                    { key: 'y', label: 'install', action: ACTION_CONFIRM },
                    { key: 'n', label: 'cancel', action: ACTION_CANCEL },
                  ],
                }
              : {}),
          },
          {
            id: FIELD_ENGINE,
            label: 'engine',
            kind: 'info',
            detail: 'Set by the model you pick, so the two cannot disagree.',
            ...(activeEngine ? { value: activeEngine } : {}),
          },
          {
            id: FIELD_LANGUAGE,
            label: 'language',
            kind: 'choice',
            keyPath: 'voice.language',
            placeholder: 'auto',
            detail: 'Language hint passed to the transcriber. `auto` detects it.',
            choices: [
              {
                id: LANGUAGE_AUTO_ID,
                label: 'auto',
                detail: 'Let the transcriber detect it.',
                action: CONFIG_ACTION.clear,
              },
              ...LANGUAGE_CHOICES.map(([code, name]) => ({
                id: code,
                label: code,
                detail: name,
                action: CONFIG_ACTION.set,
              })),
            ],
            ...(voice?.language && voice.language !== 'auto' ? { value: voice.language } : {}),
          },
          {
            id: FIELD_DEVICE,
            label: 'recorder device',
            kind: 'text',
            keyPath: 'voice.recorder.device',
            placeholder: 'none:default',
            detail: 'ffmpeg avfoundation input, as <video>:<audio>.',
            ...(voice?.recorder?.device && voice.recorder.device !== 'none:default'
              ? { value: voice.recorder.device }
              : {}),
          },
          // Autonomous capture: the hands-free session `SPC v e` starts. These
          // were configurable in the file and invisible here, which made the
          // panel look like the whole of voice configuration when it was not.
          {
            id: FIELD_AUTO_MODEL,
            label: 'auto model',
            kind: modelChoices.length > 0 ? 'choice' : 'text',
            keyPath: 'voice.autoCapture.model',
            placeholder: 'not set',
            detail: 'Model the hands-free session talks to, as <provider>/<id>.',
            ...(modelChoices.length > 0 ? { choices: modelChoices } : {}),
            ...(auto?.model ? { value: auto.model } : {}),
          },
          {
            id: FIELD_AUTO_START,
            label: 'start phrases',
            kind: 'text',
            keyPath: 'voice.autoCapture.startPhrases',
            placeholder: 'not set',
            detail: 'Spoken phrases that start a turn. Separate them with commas.',
            ...(auto?.startPhrases?.length ? { value: auto.startPhrases.join(PHRASE_SEPARATOR) } : {}),
          },
          {
            id: FIELD_AUTO_STOP,
            label: 'stop phrases',
            kind: 'text',
            keyPath: 'voice.autoCapture.stopPhrases',
            placeholder: 'not set',
            detail: 'Spoken phrases that stop narration. Separate them with commas.',
            ...(auto?.stopPhrases?.length ? { value: auto.stopPhrases.join(PHRASE_SEPARATOR) } : {}),
          },
          {
            id: FIELD_AUTO_IDLE,
            label: 'utterance idle',
            kind: 'text',
            keyPath: 'voice.autoCapture.utteranceIdleMs',
            placeholder: '3000',
            detail: 'Silence in milliseconds that ends an utterance.',
            ...(auto?.utteranceIdleMs === undefined ? {} : { value: String(auto.utteranceIdleMs) }),
          },
          {
            id: FIELD_TTS_ENGINE,
            label: 'tts engine',
            kind: 'choice',
            keyPath: 'voice.autoCapture.tts.engine',
            placeholder: 'not set',
            detail: 'Speech engine used to read replies back.',
            choices: TTS_ENGINE_CHOICES,
            ...(auto?.tts?.engine ? { value: auto.tts.engine } : {}),
          },
          {
            id: FIELD_TTS_VOICE,
            label: 'tts voice',
            kind: 'text',
            keyPath: 'voice.autoCapture.tts.voice',
            placeholder: 'system default',
            detail: 'Named system voice, e.g. Samantha.',
            ...(auto?.tts?.voice ? { value: auto.tts.voice } : {}),
          },
          {
            id: FIELD_TTS_RATE,
            label: 'tts rate',
            kind: 'text',
            keyPath: 'voice.autoCapture.tts.rate',
            placeholder: 'system default',
            detail: 'Words per minute passed to the speech engine.',
            ...(auto?.tts?.rate === undefined ? {} : { value: String(auto.tts.rate) }),
          },
        ],
      },
    ];
  }

  handlers(): Readonly<Record<string, (input: { fieldId: string; value?: string }) => Promise<void>>> {
    return {
      [ACTION_INSTALL]: async ({ value }) => this.beginInstall(value),
      [ACTION_SELECT]: async ({ value }) => this.selectModel(value),
      [ACTION_CONFIRM]: async () => this.runInstall(),
      [ACTION_CANCEL]: async () => {
        this.install = undefined;
      },
      [ACTION_ABORT]: async () => {
        this.install?.controller?.abort();
        this.install?.pty?.stop();
      },
      // An empty answer is meaningful: it accepts whatever default the command
      // is offering, which is what pressing enter at a `[Y/n]` prompt does.
      [ACTION_INPUT]: async ({ value }) => {
        this.install?.pty?.answer(value ?? '');
      },
      [CONFIG_ACTION.set]: async ({ fieldId, value }) => this.writeSimpleField(fieldId, value),
      [CONFIG_ACTION.clear]: async ({ fieldId }) => this.writeSimpleField(fieldId, undefined),
    };
  }

  reportError(error: unknown): void {
    this.notice = error instanceof Error ? error.message : String(error);
    if (this.install?.phase === 'running') this.install = undefined;
    this.deps.onStatus?.(undefined);
  }

  private safeLoad(): ResolvedVoiceConfig | undefined {
    try {
      return this.deps.loadVoice();
    } catch (error) {
      // A malformed config must not stop the panel drawing: it is where someone
      // would go to repair it.
      this.notice = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  private activeModelId(voice: ResolvedVoiceConfig | undefined): string | undefined {
    if (!voice?.engine || voice.engine === 'auto') return undefined;
    const adapter = voice.adapters?.[voice.engine];
    if (!adapter) return undefined;
    if (adapter.model.id) return VOICE_CATALOG.find((entry) => entry.id === adapter.model.id)?.id;
    return VOICE_CATALOG.find(
      (entry) => entry.download && modelTargetPath(entry, this.configDirectory) === adapter.model.path,
    )?.id;
  }

  private readiness(voice: ResolvedVoiceConfig | undefined): string {
    if (this.install?.phase === 'running') return 'installing';
    return this.activeModelId(voice) ? 'ready' : 'no model installed';
  }

  private beginInstall(entryId: string | undefined): void {
    const entry = entryId ? catalogEntryById(entryId) : undefined;
    if (!entry) return;
    if (this.install?.phase === 'running') {
      // One at a time: two installs would race on the same config write.
      this.notice = 'An install is already running.';
      return;
    }
    this.notice = undefined;
    const target = modelTargetPath(entry, this.configDirectory);
    const plan = planInstall(entry, {
      platform: this.deps.platform ?? process.platform,
      find: (binary) => findBinary(this.deps.resolver, binary),
      modelPresent: this.installedIds.has(entry.id),
      ...(target ? { modelPath: target } : {}),
    });
    const blocker = planBlocker(plan);
    if (blocker) {
      this.notice = blocker;
      return;
    }
    this.install = { entryId: entry.id, plan, phase: 'confirming' };
  }

  private async selectModel(entryId: string | undefined): Promise<void> {
    const entry = entryId ? catalogEntryById(entryId) : undefined;
    if (!entry) return;
    this.notice = undefined;
    await this.writeSelection(entry);
    await this.refresh();
  }

  private async runInstall(): Promise<void> {
    const state = this.install;
    if (!state || state.phase !== 'confirming') return;
    const entry = catalogEntryById(state.entryId);
    if (!entry) return;
    const controller = new AbortController();
    this.install = { ...state, phase: 'running', controller };

    try {
      for (const step of state.plan.steps) {
        if (step.state === 'satisfied') continue;
        controller.signal.throwIfAborted();
        await this.runStep(entry, step, controller.signal);
      }
      this.install = undefined;
      this.deps.onStatus?.(undefined);
    } catch (error) {
      this.install = undefined;
      this.deps.onStatus?.(undefined);
      // Config is written last, so an abort or failure leaves the previous
      // working setup exactly as it was.
      throw error;
    }
    await this.refresh();
  }

  private async runStep(entry: VoiceCatalogEntry, step: InstallStep, signal: AbortSignal): Promise<void> {
    this.setProgress(step.label);
    if (step.command) {
      await this.runCommandStep(step.command);
      return;
    }
    if (step.kind === 'model' && entry.download) {
      const target = modelTargetPath(entry, this.configDirectory);
      if (!target) return;
      ensureModelsDirectory(this.configDirectory);
      await downloadModelFile(
        {
          url: entry.download.url,
          targetPath: target,
          sha256: entry.download.sha256,
          ...(entry.sizeBytes === undefined ? {} : { expectedBytes: entry.sizeBytes }),
          onProgress: ({ receivedBytes, totalBytes }) =>
            this.setProgress(
              `${step.label}  ${formatBytes(receivedBytes)} / ${formatBytes(totalBytes) ?? '?'}`,
              totalBytes ? receivedBytes / totalBytes : undefined,
            ),
          signal,
        },
        this.deps.fetchImpl ?? globalThis.fetch,
      );
      return;
    }
    if (step.kind === 'config') await this.writeSelection(entry);
    if (step.kind === 'verify') this.verifyInstall(entry);
  }

  /**
   * Confirms the thing just installed can actually be run.
   *
   * Without this the install reports success and the failure surfaces later, at
   * the first recording, as `Required executable not found on PATH` with no hint
   * that a package manager put it somewhere PATH does not reach.
   */
  private verifyInstall(entry: VoiceCatalogEntry): void {
    const tooling = ENGINE_TOOLING[entry.engine];
    const binary = locateBinary(this.deps.resolver, tooling.binary, this.homeDirectory);
    if (!binary) {
      throw new Error(
        `${tooling.binary} is still not runnable after \`${tooling.installers[0]?.command}\`. ` +
          `Check where it was installed and add that directory to PATH.`,
      );
    }
    const target = modelTargetPath(entry, this.configDirectory);
    if (target && !fs.existsSync(target)) throw new Error(`The model file is missing: ${target}`);
  }

  /**
   * Runs one install command on a borrowed terminal.
   *
   * Not a buffered spawn: these are package managers, and they ask things. The
   * terminal is also a login shell, which is how `brew` gets found at all when
   * it is only on PATH through a profile script.
   */
  private async runCommandStep(command: string): Promise<void> {
    if (!this.deps.runCommand) {
      throw new Error(
        `Cannot run \`${command}\`: no terminal is available. Run it yourself, then pick the model again.`,
      );
    }
    const handle = await this.deps.runCommand({
      id: `voice-install-${Date.now()}`,
      name: command.slice(0, 48),
      command,
      cwd: this.deps.cwd?.() ?? process.cwd(),
    });
    if (this.install) this.install.pty = handle;
    this.republish();
    try {
      const code = await handle.completion;
      if (code !== 0) throw new Error(`\`${command}\` exited with code ${code}`);
    } finally {
      if (this.install) this.install.pty = undefined;
    }
  }

  private setProgress(label: string, ratio?: number): void {
    if (this.install) this.install.progress = { label, ...(ratio === undefined ? {} : { ratio }) };
    this.deps.onStatus?.(`voice: ${label}`);
    this.republish();
  }

  private async writeSelection(entry: VoiceCatalogEntry): Promise<void> {
    const adapterPath = [...VOICE_PATH, 'adapters', entry.engine];
    const target = modelTargetPath(entry, this.configDirectory);
    const tooling = ENGINE_TOOLING[entry.engine];
    const located = locateBinary(this.deps.resolver, tooling.binary, this.homeDirectory);
    // Recorded as an absolute path only when PATH alone would not find it, which
    // is the normal outcome of a pip install on macOS. Left unset otherwise, so
    // the config keeps working if the tool later moves.
    const offPath = located && !findBinary(this.deps.resolver, tooling.binary) ? located : undefined;
    const edits: DoomConfigEdit[] = [
      { keyPath: [...VOICE_PATH, 'engine'], value: entry.engine },
      { keyPath: [...adapterPath, 'binary'], ...(offPath ? { value: offPath } : {}) },
      // path and id are mutually exclusive, so the unused one goes in the same
      // write or the file is briefly invalid.
      entry.download && target
        ? { keyPath: [...adapterPath, 'model', 'path'], value: target }
        : { keyPath: [...adapterPath, 'model', 'id'], value: entry.id },
      entry.download && target
        ? { keyPath: [...adapterPath, 'model', 'id'] }
        : { keyPath: [...adapterPath, 'model', 'path'] },
    ];
    await writeDoomConfigValues(this.configPath, edits);
  }

  /**
   * Writes one field, keeping `autoCapture` a whole block.
   *
   * The config policy requires `model` and `tts` together, so a field-at-a-time
   * edit can leave the file in a state its own parser rejects - and the parser
   * runs on the NEXT write, which would blame an unrelated field. Setting the
   * model therefore seeds a default engine, clearing it removes the block, and
   * the other fields refuse to write until a model exists.
   */
  private async writeSimpleField(fieldId: string, value: string | undefined): Promise<void> {
    const keyPath = SIMPLE_FIELD_PATHS[fieldId];
    if (!keyPath) return;
    const parsed = value === undefined ? undefined : parseFieldValue(fieldId, value);
    // A number field given something that is not a number would otherwise be
    // written as a string and rejected on the next load, with the panel showing
    // it as if it had taken.
    if (typeof parsed === 'string' && NUMBER_FIELDS.has(fieldId)) {
      this.notice = `${fieldId} takes a number.`;
      return;
    }

    const edits: DoomConfigEdit[] = [{ keyPath: [...keyPath], ...(parsed === undefined ? {} : { value: parsed }) }];
    if (AUTO_CAPTURE_FIELDS.has(fieldId)) {
      const auto = this.safeLoad()?.autoCapture;
      if (fieldId === FIELD_AUTO_MODEL) {
        // Clearing the model takes the block with it: every other key under it
        // is meaningless without one, and the parser rejects a block missing it.
        if (parsed === undefined) edits[0] = { keyPath: [...AUTO_CAPTURE_PATH] };
        else if (!auto?.tts?.engine) edits.push({ keyPath: [...TTS_ENGINE_PATH], value: DEFAULT_TTS_ENGINE });
      } else if (!auto?.model) {
        this.notice = 'Set the auto model first: the rest of autonomous capture hangs off it.';
        return;
      } else if (fieldId === FIELD_TTS_ENGINE && parsed === undefined) {
        this.notice = 'The tts engine is required while autonomous capture is configured.';
        return;
      }
    }

    this.notice = undefined;
    await writeDoomConfigValues(this.configPath, edits);
  }
}

/** The plan as the panel shows it: every step, with the one running marked. */
function planSteps(state: InstallState): ConfigStep[] {
  return state.plan.steps.slice(0, MAX_STEPS).map((step) => ({
    label: step.label.slice(0, MAX_STEP_LABEL),
    state: step.state,
    ...(step.detail ? { detail: step.detail.slice(0, MAX_STEP_DETAIL) } : {}),
  }));
}

function confirmSummary(plan: InstallPlan): string {
  const commands =
    plan.commands.length > 0 ? `runs: ${plan.commands.join('; ')}` : 'nothing to install, just writes the config';
  return `install ${plan.entry.label}? ${commands}`.slice(0, MAX_DETAIL_LENGTH);
}
