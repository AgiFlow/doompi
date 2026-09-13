import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface VoiceAudioInput {
  deviceId: string;
  groupId: string;
  label: string;
}

export interface VoiceClientSettings {
  inputs: VoiceAudioInput[];
  deviceId: string | null;
}

/** Saved browser preferences. Media connection leases are deliberately stored elsewhere. */
export class VoiceClientSettingsStore {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly inputs = new Map<string, VoiceAudioInput[]>();

  public constructor(private readonly file: string) {}

  public async read(clientId: string): Promise<VoiceClientSettings> {
    await this.writes;
    const saved = await this.load();
    return { inputs: this.inputs.get(clientId) ?? [], deviceId: saved[clientId] ?? null };
  }

  public register(clientId: string, inputs: VoiceAudioInput[]): void {
    this.inputs.set(clientId, inputs);
  }

  public async select(clientId: string, deviceId: string | null): Promise<VoiceClientSettings> {
    const write = async (): Promise<void> => {
      if (deviceId !== null && !this.inputs.get(clientId)?.some((input) => input.deviceId === deviceId))
        throw new Error('Register the selected microphone before saving it.');
      const saved = await this.load();
      if (deviceId === null) delete saved[clientId];
      else saved[clientId] = deviceId;
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
      await rename(temporary, this.file);
    };
    const operation = this.writes.then(write, write);
    this.writes = operation.catch(() => undefined);
    await operation;
    return this.read(clientId);
  }

  private async load(): Promise<Record<string, string>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.values(value).some((item) => typeof item !== 'string')
      )
        throw new Error('Saved Voice client settings are invalid.');
      return Object.assign(Object.create(null) as Record<string, string>, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null) as Record<string, string>;
      throw error;
    }
  }
}
