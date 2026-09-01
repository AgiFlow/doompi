/**
 * `subagent` tool config file: read/write, and the scoped `ExtensionConfig`
 * shape this v1 tool surface actually consumes.
 *
 * PORTED FROM `doom-pi-subagents/src/extension/config.ts`, WITH THE CONFIG
 * SHAPE DELIBERATELY NARROWED, NOT COPIED WHOLESALE:
 * The predecessor's `ExtensionConfig` also carries TUI-rendering fields
 * (`fleetView`, `fleetViewPlacement`, `asyncWidget`) and fields owned by
 * ports still in progress elsewhere (`intercomBridge` is G5's,
 * `proactiveSkillSubagents` has no owner in this package yet). Modeling
 * those here would mean guessing a shape for something this task does not
 * read and cannot verify, rather than the domain that actually owns each
 * field defining it when it lands. `asyncByDefault`/`forceTopLevelAsync`
 * are dropped outright, the config-level twin of `schemas.ts` dropping the
 * `async` parameter - there is no other mode to default toward or force
 * away from.
 *
 * `toolDescriptionMode` IS kept, unlike the TUI fields above: it selects
 * which markdown text becomes the `ToolDefinition.description` this tool
 * registers - what the MODEL reads to decide how to call the tool, not
 * anything rendered for a human. That is this tool's own concern, not G8's.
 *
 * A config file written by the predecessor may still contain any of those
 * fields; `readConfigForUpdate`/`saveConfig` round-trip through
 * `JSON.parse`/`JSON.stringify` on the whole object, so fields this type
 * does not declare survive a read-modify-write cycle untouched rather than
 * being silently dropped - they are simply invisible to this tool's own
 * logic until whoever owns them ports the corresponding reader.
 *
 * `loadConfig`'s failure path reports through a plain return value, not
 * `console.*` - the child's stdout is the captured transcript (a standing
 * rule across this package), and this reader also runs in-process for the
 * parent/main session, where `console.error` would still be an ad hoc,
 * unstructured side channel outside whatever this package's own log sink is.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompletionBatchConfig } from '../../runs/background/completionBatcher';
import type { RuntimeTable } from '../../runs/shared/runtimeRegistry';
import { getAgentDir } from '../../filesystem/configDir';
import type { ArtifactDirPreference, ToolBudgetConfig } from '../../../types';

const ARTIFACT_DIR_PREFERENCES = new Set<ArtifactDirPreference>(['project', 'session', 'temp']);

export interface TopLevelParallelConfig {
  /**
   * Hard cap on how many children one top-level PARALLEL call may DECLARE.
   * Defaults to 8. This bounds one call's width only - see
   * `DEFAULT_PARALLEL_MAX_TASKS` in `spawnPlan.ts` for why `concurrency`
   * cannot serve that purpose, and `maxLiveRuns` for the bound that survives
   * concurrent calls.
   */
  maxTasks?: number;
  /** How many children may be started at once. Throttles launch rate, not the number running. Defaults to 4. */
  concurrency?: number;
  /**
   * Process-wide ceiling on children ALIVE at once, across every concurrent
   * call. Defaults to 8, the same as `maxTasks`, so a single call behaves
   * exactly as it did before admission control existed. Lower it on a small
   * machine (each Pi child was measured at 82-218 MB RSS); raise it when the
   * host can carry more.
   */
  maxLiveRuns?: number;
  /**
   * How long a queued child waits for a free slot before it is refused as a
   * per-child error. Defaults to 300000 (5 minutes).
   */
  admissionTimeoutMs?: number;
}

export type ToolDescriptionMode = 'full' | 'compact' | 'custom';

/**
 * The `subagent` config surface this tool's dispatch (`spawnPlan.ts`,
 * `managementActions.ts`) actually reads. See the module header for what
 * is deliberately not modeled yet and why.
 */
export interface ExtensionConfig {
  /**
   * External agent CLIs a run may target, merged over the shipped defaults
   * (`claude`, `antigravity`). Keyed by the name callers pass as `runtime`;
   * `pi` is not listed because it is the in-process SDK path, not a command.
   */
  runtimes?: RuntimeTable;
  defaultSessionDir?: string;
  maxSubagentDepth?: number;
  completionBatch?: CompletionBatchConfig;
  toolBudget?: ToolBudgetConfig;
  parallel?: TopLevelParallelConfig;
  /** Where to store subagent artifact files. Defaults to "session" beside the Pi transcript. Set to "project" for cwd/.doom-team, or "temp" for OS temp. */
  artifactDir?: ArtifactDirPreference;
  /**
   * How long a spawn waits for a child to signal it started before giving up.
   * Defaults to 10s. Deliberately NOT derived from the caller's `timeoutMs`:
   * that conflates "the child failed to boot" with "the work takes a while",
   * so a generous run timeout used to turn a dead child into a multi-minute
   * hang. Internal-only - a model has no useful basis for setting it.
   */
  handshakeTimeoutMs?: number;
  /**
   * Whether to append the orchestration addendum to the parent session's
   * system prompt. Defaults to enabled; set `false` to get the tools without
   * the guidance. See `orchestratorPrompt.ts` for why this is default-on.
   */
  orchestratorPrompt?: boolean;
  /** Tool description variant registered for the parent-facing subagent tool. Defaults to full. */
  toolDescriptionMode?: ToolDescriptionMode;
}

export function getConfigPath(): string {
  return path.join(getAgentDir(), 'extensions', 'subagent', 'config.json');
}

function readConfigForUpdate(configPath = getConfigPath()): ExtensionConfig {
  if (!fs.existsSync(configPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
  }
  const config = parsed as Record<string, unknown>;
  if (config.artifactDir !== undefined && !ARTIFACT_DIR_PREFERENCES.has(config.artifactDir as ArtifactDirPreference)) {
    throw new Error(`config.artifactDir must be "project", "session", or "temp"`);
  }
  return parsed as ExtensionConfig;
}

export function saveConfig(config: ExtensionConfig, configPath = getConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, '\t')}\n`, 'utf-8');
}

export function updateConfig(updater: (config: ExtensionConfig) => ExtensionConfig): ExtensionConfig {
  const configPath = getConfigPath();
  const next = updater(readConfigForUpdate(configPath));
  saveConfig(next, configPath);
  return next;
}

export interface LoadedConfig {
  config: ExtensionConfig;
  /** Present only when the file existed but could not be parsed/validated; `config` is `{}` in that case. */
  loadError?: string;
}

/**
 * Memoized `loadConfig` result, invalidated by the config file's own identity
 * (path) and revision (mtime + size).
 *
 * WHY THIS IS WORTH A CACHE: `loadConfig()` is called on every spawn, every
 * delegation request, every slash command and at tool-registration time, and
 * each call was a `readFileSync` plus a `JSON.parse` of a file that changes
 * approximately never. The stamp check replaces that with one `statSync`.
 *
 * WHY MTIME AND SIZE RATHER THAN A TTL: a TTL is wrong in both directions -
 * it serves stale config for the length of the window and re-reads an
 * unchanged file forever after. `saveConfig`/`updateConfig` both write through
 * `fs.writeFileSync`, which moves mtime, so the next `loadConfig` sees a new
 * stamp and re-reads. `updateConfig` reads through `readConfigForUpdate`
 * directly rather than this cache, so a read-modify-write cycle can never
 * round-trip a cached object.
 *
 * The cached `LoadedConfig` is handed out by reference. Every caller in this
 * package treats it as read-only; a caller that mutated it would poison
 * subsequent reads, which is why nothing here should start doing that.
 */
let configCache: { path: string; stamp: string; loaded: LoadedConfig } | undefined;

/** `undefined` for a file that is absent or unstattable; both are a stable "no config" stamp. */
function configStamp(configPath: string): string {
  try {
    const stat = fs.statSync(configPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

/** Never throws. A malformed config degrades to defaults, reported via `loadError` rather than `console.*`. */
export function loadConfig(): LoadedConfig {
  const configPath = getConfigPath();
  const stamp = configStamp(configPath);
  if (configCache?.path === configPath && configCache.stamp === stamp) return configCache.loaded;

  let loaded: LoadedConfig;
  try {
    loaded = { config: readConfigForUpdate(configPath) };
  } catch (error) {
    loaded = {
      config: {},
      loadError: `Failed to load subagent config from '${configPath}': ${(error as Error).message}`,
    };
  }
  configCache = { path: configPath, stamp, loaded };
  return loaded;
}
