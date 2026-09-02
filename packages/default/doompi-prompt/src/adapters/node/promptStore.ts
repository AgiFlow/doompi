import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildPromptDocument, parsePromptDocument } from '../../services/savedPromptDocument.ts';
import type { SavedPrompt, SavedPromptStore, SavedPromptWrite } from '../../types/prompt.ts';

/**
 * Saved prompts on disk, as Pi prompt templates.
 *
 * DESIGN PATTERNS:
 * - Writes into Pi's own global prompts directory, so `/<name>` resolves on the
 *   next start with no resource contribution from this package.
 * - Private modes and temp-file-then-rename, matching how the rest of the
 *   distribution writes user state under the agent directory.
 * - The environment and the home directory are injected, so tests get a real
 *   directory without touching the developer's own prompts.
 *
 * AVOID:
 * - Inventing a parallel store. The template file is the only source of truth.
 */

const AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
const DEFAULT_AGENT_DIR = path.join('.pi', 'agent');
const PROMPTS_DIR = 'prompts';
const TEMPLATE_SUFFIX = '.md';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MISSING_FILE_CODE = 'ENOENT';
/** A directory named like a template is not one, and reading it fails this way. */
const DIRECTORY_READ_CODE = 'EISDIR';

export interface NodeSavedPromptStoreOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === MISSING_FILE_CODE;
}

/** `<agentDir>/prompts`, honouring the same override Pi itself reads. */
export function resolvePromptsDirectory(options: NodeSavedPromptStoreOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env[AGENT_DIR_ENV]?.trim();
  const agentDir = configured ? configured : path.join(options.home ?? homedir(), DEFAULT_AGENT_DIR);
  return path.join(agentDir, PROMPTS_DIR);
}

export function createNodeSavedPromptStore(options: NodeSavedPromptStoreOptions = {}): SavedPromptStore {
  const directory = resolvePromptsDirectory(options);
  const filePath = (name: string): string => path.join(directory, `${name}${TEMPLATE_SUFFIX}`);

  return {
    async list(): Promise<readonly SavedPrompt[]> {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        // No prompts directory yet is the normal first-run state, not a fault.
        if (isMissing(error)) return [];
        throw error;
      }

      const prompts: SavedPrompt[] = [];
      for (const entry of names.filter((name) => name.endsWith(TEMPLATE_SUFFIX)).sort()) {
        const name = entry.slice(0, -TEMPLATE_SUFFIX.length);
        try {
          prompts.push(parsePromptDocument(name, await readFile(path.join(directory, entry), 'utf8')));
        } catch (error) {
          // A template that vanished or turned into a directory between the
          // listing and the read is skipped; anything else is a real fault.
          if (!isMissing(error) && errorCode(error) !== DIRECTORY_READ_CODE) throw error;
        }
      }
      return prompts;
    },

    async has(name: string): Promise<boolean> {
      try {
        const entry = await stat(filePath(name));
        return entry.isFile();
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },

    async save(prompt: SavedPrompt): Promise<SavedPromptWrite> {
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      const target = filePath(prompt.name);
      const temporary = `${target}.tmp`;
      await writeFile(temporary, buildPromptDocument(prompt), { encoding: 'utf8', mode: FILE_MODE });
      await rename(temporary, target);
      return { name: prompt.name, path: target };
    },

    async remove(name: string): Promise<boolean> {
      try {
        await rm(filePath(name));
        return true;
      } catch (error) {
        // Deleting a template that is already gone is the caller's answer, not a fault.
        if (isMissing(error)) return false;
        throw error;
      }
    },
  };
}
