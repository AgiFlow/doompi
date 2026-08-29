import type { BrowserVoiceOwnershipPayload } from '../src/types/voiceOwnership.ts';

type BrowserVoiceOwnershipCommand = Extract<BrowserVoiceOwnershipPayload, { type: 'browser-media-command' }>;

interface CursorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface CursorSnapshot {
  epoch?: string;
  retiredEpochs: string[];
  generation: number;
  revision: number;
}

const STORAGE_KEY = 'doompi.voice.ownership-cursor.v1';

function storedCursor(storage: CursorStorage | undefined): CursorSnapshot | undefined {
  if (storage === undefined) return undefined;
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '') as Partial<CursorSnapshot>;
    if (
      (parsed.epoch !== undefined && typeof parsed.epoch !== 'string') ||
      !Array.isArray(parsed.retiredEpochs) ||
      !parsed.retiredEpochs.every((epoch) => typeof epoch === 'string') ||
      typeof parsed.generation !== 'number' ||
      !Number.isSafeInteger(parsed.generation) ||
      typeof parsed.revision !== 'number' ||
      !Number.isSafeInteger(parsed.revision)
    )
      return undefined;
    return {
      ...(parsed.epoch === undefined ? {} : { epoch: parsed.epoch }),
      retiredEpochs: parsed.retiredEpochs,
      generation: parsed.generation,
      revision: parsed.revision,
    };
  } catch {
    return undefined;
  }
}

/** Accepts ordered browser media commands and remembers retired hub epochs for the tab lifetime. */
export class VoiceOwnershipCursor {
  private epoch: string | undefined;
  private readonly retiredEpochs: Set<string>;
  private generation: number;
  private revision: number;

  public constructor(private readonly storage?: CursorStorage) {
    const stored = storedCursor(storage);
    this.epoch = stored?.epoch;
    this.retiredEpochs = new Set(stored?.retiredEpochs);
    this.generation = stored?.generation ?? -1;
    this.revision = stored?.revision ?? -1;
  }

  public accept(command: BrowserVoiceOwnershipCommand): boolean {
    if (!this.acceptEpoch(command.epoch)) return false;
    if (
      command.generation < this.generation ||
      (command.generation === this.generation && command.revision <= this.revision)
    )
      return false;
    this.generation = command.generation;
    this.revision = command.revision;
    this.persist();
    return true;
  }

  private acceptEpoch(epoch: string): boolean {
    if (epoch === this.epoch) return true;
    if (this.retiredEpochs.has(epoch)) return false;
    if (this.epoch !== undefined) this.retiredEpochs.add(this.epoch);
    this.epoch = epoch;
    this.generation = -1;
    this.revision = -1;
    return true;
  }

  private persist(): void {
    try {
      this.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...(this.epoch === undefined ? {} : { epoch: this.epoch }),
          retiredEpochs: [...this.retiredEpochs],
          generation: this.generation,
          revision: this.revision,
        }),
      );
    } catch {
      // Storage denial degrades to this runtime instance rather than breaking media handoff.
    }
  }
}
