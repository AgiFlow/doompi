import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VoiceMediaWake } from '../types/clientMedia.ts';

const WAKE_DIRECTORY = 'media-wake';
const VOICE_DIRECTORY = 'doom-voice';
const DEFAULT_AGENT_DIRECTORY = ['.pi', 'agent'] as const;
const SESSION_HASH_DOMAIN = 'doompi-voice:media-wake:v1\0';
const MAX_EVENT_EPOCH_LENGTH = 200;
const POLL_MS = 1_000;
const DEBOUNCE_MS = 60;

export interface VoiceMediaWakeFileOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export interface WatchVoiceMediaWakeOptions extends VoiceMediaWakeFileOptions {
  pollMs?: number;
  debounceMs?: number;
}

export interface VoiceMediaWakePublisher {
  publish(wake: VoiceMediaWake): void;
}

export interface VoiceMediaWakeSource {
  close(): void;
}

function agentDirectory(env: NodeJS.ProcessEnv, homeDirectory: string): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured === '~') return homeDirectory;
  if (configured?.startsWith('~/')) return path.join(homeDirectory, configured.slice(2));
  return configured ? path.resolve(configured) : path.join(homeDirectory, ...DEFAULT_AGENT_DIRECTORY);
}

export function voiceMediaWakeDirectory(options: VoiceMediaWakeFileOptions = {}): string {
  if (options.directory !== undefined) return path.resolve(options.directory);
  return path.join(
    agentDirectory(options.env ?? process.env, options.homeDirectory ?? os.homedir()),
    VOICE_DIRECTORY,
    WAKE_DIRECTORY,
  );
}

export function voiceMediaWakePath(sessionId: string, options: VoiceMediaWakeFileOptions = {}): string {
  const digest = createHash('sha256').update(SESSION_HASH_DOMAIN).update(sessionId).digest('hex');
  return path.join(voiceMediaWakeDirectory(options), `${digest}.json`);
}

export function parseVoiceMediaWake(value: unknown): VoiceMediaWake | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'eventEpoch' || keys[1] !== 'sequence') return undefined;
  if (
    typeof record.eventEpoch !== 'string' ||
    record.eventEpoch.length === 0 ||
    record.eventEpoch.length > MAX_EVENT_EPOCH_LENGTH ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0
  )
    return undefined;
  return { eventEpoch: record.eventEpoch, sequence: record.sequence as number };
}

export function readVoiceMediaWake(filePath: string): VoiceMediaWake | undefined {
  try {
    return parseVoiceMediaWake(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

export function createVoiceMediaWakePublisher(
  sessionId: string,
  options: VoiceMediaWakeFileOptions = {},
): VoiceMediaWakePublisher {
  const directory = voiceMediaWakeDirectory(options);
  const target = voiceMediaWakePath(sessionId, options);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return {
    publish(wake) {
      const temporary = `${target}.${String(process.pid)}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(wake)}\n`, { mode: 0o600 });
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, target);
        fs.chmodSync(target, 0o600);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
  };
}

export function watchVoiceMediaWake(
  sessionId: string,
  onWake: (wake: VoiceMediaWake | undefined) => void,
  options: WatchVoiceMediaWakeOptions = {},
): VoiceMediaWakeSource {
  const directory = voiceMediaWakeDirectory(options);
  const target = voiceMediaWakePath(sessionId, options);
  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let fingerprint: string | undefined;
  let closed = false;

  const emit = (): void => {
    if (closed) return;
    const wake = readVoiceMediaWake(target);
    const next = wake === undefined ? 'missing' : JSON.stringify(wake);
    if (next === fingerprint) return;
    fingerprint = next;
    onWake(wake);
  };

  const ensureWatcher = (): void => {
    if (watcher !== undefined || closed) return;
    try {
      watcher = fs.watch(directory, () => {
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(emit, options.debounceMs ?? DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // The broker creates this directory when it starts. Polling keeps trying until then.
    }
  };

  ensureWatcher();
  emit();
  const poll = setInterval(() => {
    ensureWatcher();
    emit();
  }, options.pollMs ?? POLL_MS);

  return {
    close() {
      closed = true;
      if (debounce !== undefined) clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
      watcher = undefined;
    },
  };
}
