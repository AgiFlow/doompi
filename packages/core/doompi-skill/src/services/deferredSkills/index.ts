import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  type BuildSystemPromptOptions,
  formatSkillsForPrompt,
  getAgentDir,
  loadSkills,
  type Skill,
  stripFrontmatter,
} from '@earendil-works/pi-coding-agent';

export interface DeferredSkillSnapshot {
  skills: Skill[];
  diagnostics: string[];
}

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PACKAGE_MANIFEST = 'package.json';
const SKILL_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
void (async () => {
  try {
    const { loadSkills } = await import(workerData.piModuleUrl);
    parentPort.postMessage({ ok: true, result: loadSkills(workerData.loadOptions) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
})();
`;

function installedPiModuleUrl(): string {
  const anchors = [process.argv[1], fileURLToPath(import.meta.url), path.join(process.cwd(), PACKAGE_MANIFEST)];
  for (const anchor of anchors) {
    if (!anchor) continue;
    let directory = path.dirname(path.resolve(anchor));
    while (true) {
      const packageRoot = path.join(directory, 'node_modules', PI_PACKAGE);
      const manifestPath = path.join(packageRoot, PACKAGE_MANIFEST);
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { main?: unknown };
        if (typeof manifest.main === 'string') {
          const entry = path.resolve(packageRoot, manifest.main);
          if (fs.existsSync(entry)) return pathToFileURL(entry).href;
        }
      } catch {
        // This anchor does not expose Pi at this level; continue up its module chain.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error(`Cannot resolve ${PI_PACKAGE} from the DoomPi or host module trees`);
}

interface SkillWorkerResult {
  ok: boolean;
  result?: { skills: Skill[]; diagnostics: Array<{ path?: string; message: string }> };
  error?: string;
}

export interface DeferredSkillLoaderOptions {
  cwd: string;
  skillPaths: readonly string[];
  agentDir?: string;
  piModuleUrl?: string;
  schedule?: (load: () => void) => void;
  load?: (options: { cwd: string; agentDir: string; skillPaths: string[]; includeDefaults: boolean }) => {
    skills: Skill[];
    diagnostics: Array<{ path?: string; message: string }>;
  };
}

/**
 * One session's Doom-selected skill inventory.
 *
 * Construction is deliberately cheap. `start()` schedules the synchronous Pi
 * walker after session_start returns, while `ready()` is the single promise the
 * first input awaits before Pi expands `/skill:name`.
 */
export class DeferredSkillLoader {
  readonly #options: DeferredSkillLoaderOptions;
  #promise: Promise<DeferredSkillSnapshot> | undefined;

  constructor(options: DeferredSkillLoaderOptions) {
    this.#options = options;
  }

  start(): Promise<DeferredSkillSnapshot> {
    if (this.#promise) return this.#promise;

    if (!this.#options.schedule && !this.#options.load) {
      this.#promise = this.#loadInWorker();
      return this.#promise;
    }

    const schedule = this.#options.schedule ?? ((load: () => void) => setImmediate(load));
    this.#promise = new Promise((resolve) => {
      const fail = (error: unknown): void => {
        resolve(this.#failure(error));
      };
      try {
        schedule(() => {
          try {
            resolve(this.#load());
          } catch (error) {
            fail(error);
          }
        });
      } catch (error) {
        fail(error);
      }
    });
    return this.#promise;
  }

  ready(): Promise<DeferredSkillSnapshot> {
    return this.start();
  }

  #loadOptions(): { cwd: string; agentDir: string; skillPaths: string[]; includeDefaults: boolean } {
    return {
      cwd: this.#options.cwd,
      agentDir: this.#options.agentDir ?? getAgentDir(),
      skillPaths: [...this.#options.skillPaths],
      includeDefaults: false,
    };
  }

  #snapshot(result: {
    skills: Skill[];
    diagnostics: Array<{ path?: string; message: string }>;
  }): DeferredSkillSnapshot {
    return {
      skills: result.skills,
      diagnostics: result.diagnostics.map(
        (diagnostic) => `${diagnostic.path ?? this.#options.cwd}: ${diagnostic.message}`,
      ),
    };
  }

  #failure(error: unknown): DeferredSkillSnapshot {
    return {
      skills: [],
      diagnostics: [`${this.#options.cwd}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  #load(): DeferredSkillSnapshot {
    return this.#snapshot((this.#options.load ?? loadSkills)(this.#loadOptions()));
  }

  #loadInWorker(): Promise<DeferredSkillSnapshot> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (snapshot: DeferredSkillSnapshot): void => {
        if (settled) return;
        settled = true;
        resolve(snapshot);
      };
      let worker: Worker;
      try {
        worker = new Worker(SKILL_WORKER_SOURCE, {
          eval: true,
          workerData: {
            piModuleUrl: this.#options.piModuleUrl ?? installedPiModuleUrl(),
            loadOptions: this.#loadOptions(),
          },
        });
      } catch (error) {
        settle(this.#failure(error));
        return;
      }
      worker.unref();
      worker.once('message', (message: SkillWorkerResult) => {
        if (!message.ok || !message.result) {
          settle(this.#failure(message.error ?? 'Skill worker failed'));
          return;
        }
        settle(this.#snapshot(message.result));
      });
      worker.once('error', (error) => settle(this.#failure(error)));
      worker.once('exit', (code) => {
        if (code !== 0) settle(this.#failure(`Skill worker exited with code ${code}`));
      });
    });
  }
}

/** Appends only the inventory Pi would append for these deferred skills. */
export function buildPromptWithDeferredSkills(
  systemPrompt: string,
  options: BuildSystemPromptOptions,
  skills: Skill[],
): string {
  if (options.selectedTools && !options.selectedTools.includes('read')) return systemPrompt;
  return `${systemPrompt}${formatSkillsForPrompt(skills)}`;
}

/** Expands a deferred `/skill:name` before Pi consults its synchronous inventory. */
export function expandDeferredSkillCommand(text: string, skills: readonly Skill[]): string {
  if (!text.startsWith('/skill:')) return text;
  const spaceIndex = text.indexOf(' ');
  const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill) return text;

  try {
    const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();
    const body = stripFrontmatter(fs.readFileSync(skill.filePath, 'utf8')).trim();
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${skillBlock}\n\n${args}` : skillBlock;
  } catch {
    // Pi uses the same literal-text fallback if a skill disappears between
    // discovery and submission; the agent can still respond to the command.
    return text;
  }
}
