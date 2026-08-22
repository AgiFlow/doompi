import fs from 'node:fs';
import path from 'node:path';

import type { ResolvedVoiceConfig, VoiceAdapterConfig, VoiceEngine } from '@agimon-ai/doompi-config';
import {
  type IExecutableResolver,
  type IProcessSpawner,
  type ITranscriberAdapter,
  type ITranscriberRegistry,
  type SelectedTranscriber,
  type TranscriptionRequest,
} from '../../types/index.ts';

const AUTO_LANGUAGE = 'auto';
const WHISPER_CPP_ENGINE = 'whisper-cpp' as const;
const OPENAI_WHISPER_ENGINE = 'openai-whisper' as const;
const MLX_WHISPER_ENGINE = 'mlx-whisper' as const;
const WHISPER_CPP_BINARY = 'whisper-cli';
const OPENAI_WHISPER_BINARY = 'whisper';
const MLX_WHISPER_BINARY = 'mlx_whisper';
const TEXT_OUTPUT_FORMAT = 'txt';

function assertModelPath(config: VoiceAdapterConfig): void {
  if (config.model.path && !fs.existsSync(config.model.path))
    throw new Error(`Voice model not found: ${config.model.path}`);
}

function requireModel(config: VoiceAdapterConfig): string {
  const model = config.model.path ?? config.model.id;
  if (!model) throw new Error('Voice adapter requires a model path or id');
  return model;
}

function assertSuccess(engine: string, result: { code: number; stderr: string }): void {
  if (result.code !== 0)
    throw new Error(`${engine} transcription failed: ${result.stderr || `exit code ${result.code}`}`);
}

export class WhisperCppAdapter implements ITranscriberAdapter {
  public readonly engine = WHISPER_CPP_ENGINE;

  public constructor(
    private readonly executables: IExecutableResolver,
    private readonly spawner: IProcessSpawner,
  ) {}

  public preflight(config: VoiceAdapterConfig): void {
    this.executables.resolve(config.binary, WHISPER_CPP_BINARY);
    assertModelPath(config);
    if (!config.model.path) throw new Error('whisper-cpp requires a local model path');
  }

  public async transcribe(request: TranscriptionRequest): Promise<string> {
    const outputPrefix = path.join(request.workspace, WHISPER_CPP_ENGINE);
    const args = [
      '--model',
      requireModel(request.config),
      '--file',
      request.audioPath,
      '--output-txt',
      '--output-file',
      outputPrefix,
      '--no-timestamps',
    ];
    if (request.language !== AUTO_LANGUAGE) args.push('--language', request.language);
    const result = await this.spawner.run(this.executables.resolve(request.config.binary, WHISPER_CPP_BINARY), args, {
      signal: request.signal,
    });
    assertSuccess(this.engine, result);
    return fs.readFileSync(`${outputPrefix}.txt`, 'utf8').trim();
  }
}

export class OpenAiWhisperAdapter implements ITranscriberAdapter {
  public readonly engine = OPENAI_WHISPER_ENGINE;

  public constructor(
    private readonly executables: IExecutableResolver,
    private readonly spawner: IProcessSpawner,
  ) {}

  public preflight(config: VoiceAdapterConfig): void {
    this.executables.resolve(config.binary, OPENAI_WHISPER_BINARY);
    assertModelPath(config);
    requireModel(config);
  }

  public async transcribe(request: TranscriptionRequest): Promise<string> {
    const args = [
      request.audioPath,
      '--model',
      requireModel(request.config),
      '--output_format',
      TEXT_OUTPUT_FORMAT,
      '--output_dir',
      request.workspace,
    ];
    if (request.language !== AUTO_LANGUAGE) args.push('--language', request.language);
    const result = await this.spawner.run(
      this.executables.resolve(request.config.binary, OPENAI_WHISPER_BINARY),
      args,
      { signal: request.signal },
    );
    assertSuccess(this.engine, result);
    return fs.readFileSync(path.join(request.workspace, `${path.parse(request.audioPath).name}.txt`), 'utf8').trim();
  }
}

export class MlxWhisperAdapter implements ITranscriberAdapter {
  public readonly engine = MLX_WHISPER_ENGINE;

  public constructor(
    private readonly executables: IExecutableResolver,
    private readonly spawner: IProcessSpawner,
  ) {}

  public preflight(config: VoiceAdapterConfig): void {
    this.executables.resolve(config.binary, MLX_WHISPER_BINARY);
    assertModelPath(config);
    requireModel(config);
  }

  public async transcribe(request: TranscriptionRequest): Promise<string> {
    const outputName = MLX_WHISPER_ENGINE;
    const args = [
      request.audioPath,
      '--model',
      requireModel(request.config),
      '--output-dir',
      request.workspace,
      '--output-name',
      outputName,
      '--output-format',
      TEXT_OUTPUT_FORMAT,
    ];
    if (request.language !== AUTO_LANGUAGE) args.push('--language', request.language);
    const result = await this.spawner.run(this.executables.resolve(request.config.binary, MLX_WHISPER_BINARY), args, {
      signal: request.signal,
    });
    assertSuccess(this.engine, result);
    return fs.readFileSync(path.join(request.workspace, `${outputName}.txt`), 'utf8').trim();
  }
}

export class TranscriberRegistry implements ITranscriberRegistry {
  private readonly adapters: Record<Exclude<VoiceEngine, 'auto'>, ITranscriberAdapter>;

  public constructor(whisperCpp: ITranscriberAdapter, openAi: ITranscriberAdapter, mlx: ITranscriberAdapter) {
    this.adapters = {
      [WHISPER_CPP_ENGINE]: whisperCpp,
      [OPENAI_WHISPER_ENGINE]: openAi,
      [MLX_WHISPER_ENGINE]: mlx,
    };
  }

  public select(config: ResolvedVoiceConfig): SelectedTranscriber {
    const engines: Exclude<VoiceEngine, 'auto'>[] =
      config.engine === AUTO_LANGUAGE
        ? [WHISPER_CPP_ENGINE, OPENAI_WHISPER_ENGINE, MLX_WHISPER_ENGINE]
        : [config.engine];
    const errors: string[] = [];
    for (const engine of engines) {
      const adapterConfig = config.adapters[engine];
      if (!adapterConfig) {
        errors.push(`${engine}: not configured`);
        continue;
      }
      try {
        const adapter = this.adapters[engine];
        adapter.preflight(adapterConfig);
        return { adapter, config: adapterConfig };
      } catch (error) {
        errors.push(`${engine}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`No usable voice transcription adapter. ${errors.join('; ')}`);
  }
}
