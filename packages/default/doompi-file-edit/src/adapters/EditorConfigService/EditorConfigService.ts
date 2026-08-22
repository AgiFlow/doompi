import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { globalDoomConfigPath } from '@agimon-ai/doompi-config';
import type { IEditorConfigService } from '../../types/editorConfigService';

const commandPattern = /^\s*command:\s*(.+?)\s*$/mu;

function agentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

export class EditorConfigService implements IEditorConfigService {
  path(): string {
    return globalDoomConfigPath();
  }

  packagePath(): string {
    return path.join(agentDirectory(), 'doom-file-edit', 'config.yaml');
  }

  async command(): Promise<string | undefined> {
    // Shared Doom config owns `editor:`; the package-scoped file is the
    // fallback for standalone installs that have no Doom config.
    return (await this.read(this.path())) ?? (await this.read(this.packagePath()));
  }

  private async read(filePath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const editorSection = /^editor:\s*\n((?:[ \t]+.*(?:\n|$))*)/mu.exec(content)?.[1];
      if (!editorSection) return undefined;
      const value = commandPattern.exec(editorSection)?.[1]?.trim();
      if (!value) return undefined;
      if (/^(?:[-+]?\d+(?:\.\d+)?|true|false|null)$/u.test(value)) {
        throw new Error(`${filePath}: editor.command must be a string`);
      }
      return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
