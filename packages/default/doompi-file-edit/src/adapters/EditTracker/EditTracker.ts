import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileEditTool } from '../../types/domain';
import type { ITimelineStore } from '../../types/timelineStore';
import type { IEditTracker } from '../../types/editTracker';

const EDIT_TOOL = 'edit';
const WRITE_TOOL = 'write';
const BASH_TOOL = 'bash';
const MISSING_PATH_ERROR_CODES = new Set(['ENOENT', 'ENAMETOOLONG']);

interface Fingerprint {
  exists: boolean;
  size: number;
  modified: number;
}

interface PendingEdit {
  tool: FileEditTool;
  paths: Map<string, Fingerprint>;
}

function objectValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
}

export class EditTracker implements IEditTracker {
  private readonly pending = new Map<string, PendingEdit>();

  constructor(private readonly timeline: ITimelineStore) {}

  async start(id: string, tool: string, args: unknown, cwd: string): Promise<void> {
    if (tool === EDIT_TOOL || tool === WRITE_TOOL) {
      const supplied = objectValue(args, 'path');
      if (!supplied) return;
      const absolute = path.resolve(cwd, supplied);
      this.pending.set(id, { tool, paths: new Map([[absolute, await this.fingerprint(absolute)]]) });
      return;
    }
    if (tool !== BASH_TOOL) return;
    const command = objectValue(args, 'command');
    if (!command) return;
    const paths = new Map<string, Fingerprint>();
    for (const candidate of this.literalPaths(command, cwd)) paths.set(candidate, await this.fingerprint(candidate));
    this.pending.set(id, { tool: BASH_TOOL, paths });
  }

  async end(id: string, isError: boolean): Promise<void> {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!pending || isError) return;
    for (const [filePath, before] of pending.paths) {
      const after = await this.fingerprint(filePath);
      const exactTool = pending.tool === EDIT_TOOL || pending.tool === WRITE_TOOL;
      if (exactTool || JSON.stringify(before) !== JSON.stringify(after)) {
        await this.timeline.append({ version: 1, path: filePath, tool: pending.tool, at: Date.now() });
      }
    }
  }

  private literalPaths(command: string, cwd: string): string[] {
    const tokens = command.match(/"[^"]+"|'[^']+'|[^\s|;&<>]+/gu) ?? [];
    const candidates = tokens
      .map((token) => token.replace(/^['"]|['"]$/gu, ''))
      .filter((token) => !token.startsWith('-') && (token.includes('/') || /\.[a-z0-9_-]+$/iu.test(token)))
      .map((token) => path.resolve(cwd, token));
    return [...new Set(candidates)];
  }

  private async fingerprint(filePath: string): Promise<Fingerprint> {
    try {
      const stat = await fs.stat(filePath);
      return { exists: stat.isFile(), size: stat.size, modified: stat.mtimeMs };
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        MISSING_PATH_ERROR_CODES.has(error.code)
      ) {
        return { exists: false, size: 0, modified: 0 };
      }
      throw error;
    }
  }
}
