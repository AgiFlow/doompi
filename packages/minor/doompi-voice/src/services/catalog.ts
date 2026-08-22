/**
 * The models the config panel offers, and what installing one means per engine.
 *
 * Hardcoded rather than fetched: the panel has to render a list offline, and a
 * catalog that needs the network to show you what you could download is no use
 * on the machine that has not got it yet.
 *
 * The two engine families differ in a way the panel has to show:
 *
 * - whisper-cpp takes a local ggml file and cannot take a model id at all, so
 *   installing means downloading a specific file to a path we then write into
 *   the config. Checksums are pinned because the file is fetched over the
 *   network and then executed against.
 * - the Python engines take a model id and fetch it themselves on first use, so
 *   installing means making sure the tool exists and writing the id down.
 *
 * The sizes and checksums are the HuggingFace LFS metadata for
 * `ggerganov/whisper.cpp`, read from its API. The oid is the file's sha256.
 */

import type { VoiceEngine } from '@agimon-ai/doompi-config';

const WHISPER_CPP_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export type VoiceCatalogEngine = Exclude<VoiceEngine, 'auto'>;

export interface Installer {
  /** The binary that must be on PATH for `command` to run at all. */
  readonly requires: string;
  readonly command: string;
}

export interface VoiceCatalogEntry {
  /** Stable id, and the value written to config for id-based engines. */
  readonly id: string;
  readonly engine: VoiceCatalogEngine;
  readonly label: string;
  /** Undefined when the engine fetches the model itself and we cannot know the size. */
  readonly sizeBytes?: number;
  /** Set only for engines we download for. Its presence is what makes an entry downloadable. */
  readonly download?: {
    readonly url: string;
    readonly fileName: string;
    readonly sha256: string;
  };
}

function whisperCpp(name: string, sizeBytes: number, sha256: string): VoiceCatalogEntry {
  const fileName = `ggml-${name}.bin`;
  return {
    id: `whisper-cpp/${name}`,
    engine: 'whisper-cpp',
    label: name,
    sizeBytes,
    download: { url: `${WHISPER_CPP_BASE_URL}/${fileName}`, fileName, sha256 },
  };
}

function pythonModel(engine: VoiceCatalogEngine, id: string, label: string): VoiceCatalogEntry {
  return { id, engine, label };
}

export const VOICE_CATALOG: readonly VoiceCatalogEntry[] = [
  whisperCpp('tiny', 77_691_713, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'),
  whisperCpp('base', 147_951_465, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'),
  whisperCpp('small', 487_601_967, '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'),
  whisperCpp('medium', 1_533_763_059, '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208'),
  whisperCpp('large-v3-turbo', 1_624_555_275, '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69'),
  pythonModel('openai-whisper', 'base', 'base'),
  pythonModel('openai-whisper', 'small', 'small'),
  pythonModel('openai-whisper', 'turbo', 'turbo'),
  pythonModel('mlx-whisper', 'mlx-community/whisper-large-v3-turbo', 'large-v3-turbo'),
  pythonModel('mlx-whisper', 'mlx-community/whisper-small-mlx', 'small'),
];

/** The binary each engine is invoked as, and how to install it when it is absent. */
export const ENGINE_TOOLING: Readonly<
  Record<
    VoiceCatalogEngine,
    { readonly binary: string; readonly installers: readonly Installer[]; readonly detail: string }
  >
> = {
  'whisper-cpp': {
    binary: 'whisper-cli',
    // A C++ binary, so brew is the only way in; there is no pip package.
    installers: [{ requires: 'brew', command: 'brew install whisper-cpp' }],
    detail: 'local file · no python',
  },
  'openai-whisper': {
    binary: 'whisper',
    installers: [
      { requires: 'brew', command: 'brew install openai-whisper' },
      { requires: 'pip3', command: 'pip3 install -U openai-whisper' },
      { requires: 'pip', command: 'pip install -U openai-whisper' },
    ],
    detail: 'python · fetched on first use',
  },
  'mlx-whisper': {
    binary: 'mlx_whisper',
    // No brew formula for this one, so pip is the only route.
    installers: [
      { requires: 'pip3', command: 'pip3 install -U mlx-whisper' },
      { requires: 'pip', command: 'pip install -U mlx-whisper' },
    ],
    detail: 'python · apple silicon',
  },
};

/**
 * Picks the first installer whose own command is on PATH.
 *
 * Homebrew first where a formula exists: it is the one a Mac is most likely to
 * have, and it keeps the tool upgradable alongside everything else. A stock
 * macOS has no bare `pip`, so `pip3` is tried before it rather than after.
 */
export function resolveInstaller(
  engine: VoiceCatalogEngine,
  find: (binary: string) => string | undefined,
): Installer | undefined {
  return ENGINE_TOOLING[engine].installers.find((installer) => find(installer.requires));
}

export function installerRequirements(engine: VoiceCatalogEngine): string {
  return ENGINE_TOOLING[engine].installers.map((installer) => installer.requires).join(' or ');
}

/**
 * The contract caps a choice group at 48 characters and rejects the whole
 * snapshot past it, which takes the extension's registration down rather than
 * just truncating a label. Building the string here keeps that cap in one place.
 */
export const MAX_GROUP_LENGTH = 48;

export function engineGroupLabel(engine: VoiceCatalogEngine): string {
  return `${engine}   ${ENGINE_TOOLING[engine].detail}`.slice(0, MAX_GROUP_LENGTH);
}

export function catalogEntryById(id: string): VoiceCatalogEntry | undefined {
  return VOICE_CATALOG.find((entry) => entry.id === id);
}

/** Human-readable size, used in the panel's right-hand column. */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
