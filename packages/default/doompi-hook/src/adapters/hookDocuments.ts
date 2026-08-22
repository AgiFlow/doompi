import fs from 'node:fs';
import { doomConfigCandidates } from '@agimon-ai/doompi-config/layeredConfig';
import { parse as parseYaml } from 'yaml';
import type {
  HookDocumentReader,
  HookDocumentSource,
  PluginDocumentRead,
  PluginHookConfig,
  PluginHookDocument,
  PluginHookSourceRef,
  RegistryDocument,
  RegistryEntry,
  RegistryRead,
} from '../types/hooks.ts';
import { HOOK_TELEMETRY_EVENT, type HookTelemetry } from '../types/telemetry.ts';
import { registryCacheKey, registryEntries } from '../services/hookRegistry.ts';

const HOOKS_FILE = 'hooks.yaml';
const FILE_ENCODING = 'utf8';
const FILE_NOT_FOUND_ERROR = 'ENOENT';
const REGISTRY_SOURCE_ATTRIBUTE = 'repository';

export interface HookDocumentReaderOptions {
  telemetry?: HookTelemetry;
  /** Where the global `.doom` directory lives. Defaults to the user's home. */
  homeDirectory?: string;
  readFile?: (filePath: string) => Promise<string>;
  warn?: (message: string) => void;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === FILE_NOT_FOUND_ERROR;
}

/**
 * Reads `.doom/hooks.yaml` from the global config directory and the repository,
 * and the plugin hook configs the harness resolved.
 *
 * Every file is re-read on every dispatch: it costs almost nothing and keeps an
 * in-place rewrite visible, which an mtime check would miss when two writes land
 * inside the same filesystem timestamp granularity. Both caches are keyed on
 * contents instead, so parsing — the expensive half — is what they skip.
 */
export function createHookDocumentReader(options: HookDocumentReaderOptions = {}): HookDocumentReader {
  const readFile = options.readFile ?? ((filePath: string) => fs.promises.readFile(filePath, FILE_ENCODING));
  const telemetry = options.telemetry;
  const warn = options.warn ?? ((message: string) => void process.stderr.write(message));
  let cachedRegistryKey: string | undefined;
  let cachedRegistryEntries: RegistryEntry[] = [];
  const pluginConfigCache = new Map<string, { source: string; config: PluginHookConfig }>();

  const readSource = async (candidate: {
    filePath: string;
    baseDirectory: string;
  }): Promise<HookDocumentSource | undefined> => {
    try {
      return { baseDirectory: candidate.baseDirectory, text: await readFile(candidate.filePath) };
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  };

  const parseSources = (sources: ReadonlyArray<HookDocumentSource>): RegistryEntry[] => {
    const key = registryCacheKey(sources);
    if (cachedRegistryKey === key) return cachedRegistryEntries;
    cachedRegistryEntries = registryEntries(
      sources.map((source) => ({
        baseDirectory: source.baseDirectory,
        document: (parseYaml(source.text) ?? {}) as RegistryDocument,
      })),
    );
    cachedRegistryKey = key;
    return cachedRegistryEntries;
  };

  return {
    async registry(repoRoot: string): Promise<RegistryRead> {
      const candidates = doomConfigCandidates(HOOKS_FILE, repoRoot, options.homeDirectory);
      // Named for the error path only. A registry absent from both locations is
      // a repository with no hooks, not a failure, so only a file that exists
      // and cannot be read or parsed reaches the catch below.
      const registryPath = candidates.map((candidate) => candidate.filePath).join(' and ');
      try {
        const sources = (await Promise.all(candidates.map(readSource))).filter(
          (source): source is HookDocumentSource => source !== undefined,
        );
        return { entries: parseSources(sources) };
      } catch (error) {
        // This empties the registry for the whole dispatch, so every repository
        // hook silently stops running rather than any one of them failing.
        void telemetry?.recordError(HOOK_TELEMETRY_EVENT.hookRegistryReadFailed, error, {
          'hook.registry.source': REGISTRY_SOURCE_ATTRIBUTE,
        });
        warn(`[pi-hook] could not read ${registryPath}: ${reason(error)}\n`);
        return { entries: [], failure: { command: registryPath, message: reason(error), reason: 'registry_read' } };
      }
    },

    async plugins(sources: readonly PluginHookSourceRef[]): Promise<PluginDocumentRead> {
      const documents: PluginHookDocument[] = [];
      const failures: PluginDocumentRead['failures'] = [];
      for (const source of sources) {
        try {
          const text = await readFile(source.configPath);
          const cached = pluginConfigCache.get(source.configPath);
          const config = cached?.source === text ? cached.config : (JSON.parse(text) as PluginHookConfig);
          pluginConfigCache.set(source.configPath, { source: text, config });
          documents.push({ pluginRoot: source.pluginRoot, config });
        } catch (error) {
          failures.push({ command: source.configPath, message: reason(error), reason: 'plugin_config' });
        }
      }
      return { documents, failures };
    },
  };
}
