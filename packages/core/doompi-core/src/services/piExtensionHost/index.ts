import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import type {
  AgentHarnessTool,
  AgentMessage,
  CompactionPreparation as HarnessCompactionPreparation,
  Entry,
  HarnessEvent,
  HookMap,
  JsonValue,
  Skill,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import {
  createEventBus,
  DefaultPackageManager,
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  initTheme,
  loadSkills,
  SessionManager,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type BoundaryContextPreview,
  type CompactionResult,
  type SessionBeforeCompactEvent,
  type Extension,
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionUIContext,
  type LoadExtensionsResult,
  type ModelRuntime,
  type RegisteredTool,
  type SessionEntry,
  type SettingsManager,
  type ToolInfo,
} from '@earendil-works/pi-coding-agent';

import type { DoomHeadlessClient, DoomHeadlessClientRequest, DoomHeadlessToolResult } from '../../exports/headless';
import { connectDoomCordisHost, type DoomCordisHostConnection } from '../../pi/cordisHost';
import { contextTokensOf, contextUsageOf, latestAssistantUsage } from '../../services/contextUsage';
import {
  fromPiSessionEntry,
  toPiFileEntries,
  toPiSessionEntries,
  toPiSessionEntry,
  type PiSessionHeaderInput,
} from '../../services/piSessionEntries';
import { readSyncRegistration } from '../../services/syncRegistration';
import type { ToolPromptEntry } from '../../services/toolPrompt';
import type { DirectHarnessRuntime } from '../../types/server/directHarnessRuntime';

/**
 * Pi entries for this worktree, taken from the validated sync registration.
 *
 * This is the same admission gate Pi's own managed dispatcher applies: the registration is
 * checked for protocol version, worktree identity, state hash, and manifest agreement before
 * any entry is returned. An unsynced or mismatched worktree contributes nothing.
 */
export function resolvePiExtensionEntries(repoRoot: string): readonly string[] {
  try {
    const registration = readSyncRegistration(repoRoot);
    return registration ? [registration.package.entry] : [];
  } catch {
    // A stale or mismatched registration is a normal unsynced state, not a session failure.
    return [];
  }
}

/**
 * Extension entries of the packages listed under `packages` in Pi's settings.json.
 *
 * Interactive Pi expands that list through its resource loader, which this server does not run,
 * so a provider package such as a local Claude Code bridge would load under `pi` and be missing
 * here. Only `packages` entries are taken: Pi's top-level `extensions` list can name DoomPi
 * itself, and the auto-discovered `extensions/` folders are already loaded by
 * `discoverAndLoadExtensions`. A package that is not installed is skipped, never installed, so
 * starting a session cannot trigger a network install.
 */
export async function resolvePiSettingsPackageEntries(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly settings: SettingsManager;
  readonly onNotice?: (message: string) => void;
}): Promise<readonly string[]> {
  try {
    const packages = new DefaultPackageManager({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager: options.settings,
    });
    const resolved = await packages.resolve(async (source) => {
      options.onNotice?.(`Pi package ${source} is not installed; skipped. Install it with pi to load it here.`);
      return 'skip';
    });
    return resolved.extensions
      .filter((resource) => resource.enabled && resource.metadata.origin === 'package')
      .map((resource) => resource.path);
  } catch (error) {
    // Settings packages are optional additions; a broken entry must not stop the session.
    options.onNotice?.(`Pi settings packages: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Load Pi extensions and apply their provider registrations to the model runtime.
 *
 * `pi.registerProvider` only queues into the extension runtime while extensions load; Pi drains
 * that queue in `ExtensionRunner.bindCore`. The runner cannot exist before the harness runtime,
 * and the harness runtime is built from an already-resolved model, so waiting for `bindCore`
 * would resolve the session's default model before extension providers exist and silently fall
 * back to the first available model. Draining the queue here puts provider registration ahead of
 * model resolution.
 *
 * The result is returned so `createPiExtensionHost` reuses it instead of discovering again, which
 * keeps every extension factory running exactly once.
 */
export async function preloadPiExtensions(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly models: ModelRuntime;
  readonly extensionPaths: readonly string[];
  readonly onNotice?: (message: string) => void;
}): Promise<(LoadExtensionsResult & { readonly events?: ReturnType<typeof createEventBus> }) | undefined> {
  if (options.extensionPaths.length === 0) return undefined;

  const events = createEventBus();
  const result = await discoverAndLoadExtensions([...options.extensionPaths], options.cwd, options.agentDir, events);
  for (const failure of result.errors) options.onNotice?.(`Pi extension ${failure.path}: ${failure.error}`);

  // The same target bindCore uses: without providerActions it registers through ModelRegistry,
  // which delegates to this ModelRuntime.
  const registry = new ModelRegistry(options.models);
  const report = (extensionPath: string, error: unknown): void =>
    options.onNotice?.(
      `Pi extension ${extensionPath}: provider registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );

  for (const pending of result.runtime.pendingProviderRegistrations) {
    try {
      registry.registerProvider(pending.name, pending.config);
    } catch (error) {
      report(pending.extensionPath, error);
    }
  }
  for (const pending of result.runtime.pendingNativeProviderRegistrations) {
    try {
      registry.registerProvider(pending.provider);
    } catch (error) {
      report(pending.extensionPath, error);
    }
  }
  // Cleared so bindCore does not repeat registrations already applied to the same runtime.
  result.runtime.pendingProviderRegistrations = [];
  result.runtime.pendingNativeProviderRegistrations = [];

  return Object.assign(result, { events });
}
/**
 * Pi native extensions are session lifetime. They contribute tools once and are never
 * retracted, so they are merged at the harness apply boundary rather than contributed to the
 * headless kernel, whose active layers come solely from server bundle candidates and would
 * drop any owner that is not a declared facet package.
 *
 * Their event handlers are a second surface. Pi drives them from an interactive
 * AgentSession this server does not run, so the handful the harness can speak to
 * faithfully are bridged here: the two agent-loop notifications an extension needs
 * to observe a turn, and the three hooks that let one shape or replace context.
 * Everything else stays undelivered rather than being approximated.
 */
export interface PiExtensionHostOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly models: ModelRuntime;
  readonly runtime: DirectHarnessRuntime;
  /**
   * Extensions already loaded by `preloadPiExtensions`, or undefined when this worktree
   * contributes none. Reused rather than re-discovered so each factory runs exactly once.
   */
  readonly preload: (LoadExtensionsResult & { readonly events?: ReturnType<typeof createEventBus> }) | undefined;
  /** Current model, tracked by the caller because harness session metadata does not carry it. */
  readonly getModel: () => Model<Api> | undefined;
  readonly getThinkingLevel: () => ThinkingLevel;
  /**
   * Resolved at call time, because the host is constructed while the session is still assembling.
   * Backs Pi's extension dialogs, notifications and status text.
   */
  readonly client: () => DoomHeadlessClient | undefined;
  readonly onNotice?: (message: string) => void;
  /**
   * Called when a Pi extension tool restriction changes the active set.
   *
   * Doom extensions register their restrictions asynchronously, after the first tool apply has
   * already run, so the caller has to re-apply rather than read `tools` once at load.
   */
  readonly onActiveToolsChanged?: () => void;
}

export interface PiExtensionHost {
  /** Session lifetime tools contributed by Pi extensions, in load order. */
  readonly tools: readonly AgentHarnessTool<object | undefined>[];
  /**
   * System-prompt guidance for those same tools, in the same order.
   *
   * `AgentHarnessTool` has no field for it, so it cannot ride on the harness
   * tool the way it does on a Pi extension definition, and the headless host
   * renders it into the prompt itself.
   */
  readonly toolGuidance: readonly ToolPromptEntry[];
  /** Session lifetime skills contributed by Pi extensions, in discovery order. */
  readonly skills: readonly Skill[];
  executeTool(
    name: string,
    toolCallId: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (result: DoomHeadlessToolResult) => void,
  ): Promise<DoomHeadlessToolResult>;
  /**
   * Pi's `context` event, as one step in the host's transform chain.
   *
   * Returns the messages unchanged when no extension is loaded, so the caller can
   * chain it unconditionally.
   */
  transformContext(messages: AgentMessage[]): Promise<AgentMessage[]>;
  /** Pi's `session_before_compact` event, translated into the harness hook's answer. */
  beforeCompaction(event: HookMap['before_compaction']['event']): Promise<HookMap['before_compaction']['result']>;
  /** Reads a session service from the Pi Cordis root without exposing registration APIs. */
  getService<T>(name: string): T | undefined;
  load(): Promise<void>;
  shutdown(): Promise<void>;
}
/** Pi does not export the preparation type on its own, only through the event that carries it. */
type PiCompactionPreparation = SessionBeforeCompactEvent['preparation'];

/**
 * The compaction boundary, named the way Pi names it.
 *
 * Pi identifies the cut by the first entry it keeps; the harness carries the kept
 * messages inline instead. Counting whole entries back from the tip until the kept
 * messages are covered recovers the id, and {@link retainedTailFrom} is its exact
 * inverse, so an extension that echoes the id it was given gets its own tail back.
 */
function boundaryEntryId(branchEntries: readonly SessionEntry[], retainedCount: number): string | undefined {
  let remaining = retainedCount;
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry === undefined) continue;
    if (remaining <= 0) return entry.id;
    remaining -= sessionEntryToContextMessages(entry).length;
    if (remaining <= 0) return entry.id;
  }
  return branchEntries[0]?.id;
}

/** The messages an entry id keeps, which is what the harness stores on the compaction entry. */
function retainedTailFrom(branchEntries: readonly SessionEntry[], firstKeptEntryId: string): AgentMessage[] {
  const index = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (index === -1) return [];
  return branchEntries.slice(index).flatMap((entry) => sessionEntryToContextMessages(entry));
}

function toPiCompactionPreparation(
  preparation: HarnessCompactionPreparation,
  branchEntries: readonly SessionEntry[],
): PiCompactionPreparation {
  return {
    firstKeptEntryId: boundaryEntryId(branchEntries, preparation.retainedTail.length) ?? '',
    messagesToSummarize: preparation.messagesToSummarize,
    turnPrefixMessages: preparation.turnPrefixMessages,
    isSplitTurn: preparation.isSplitTurn,
    tokensBefore: preparation.tokensBefore,
    ...(preparation.previousSummary === undefined ? {} : { previousSummary: preparation.previousSummary }),
    fileOps: preparation.fileOps,
    settings: preparation.settings,
  };
}

function toHarnessCompactResult(
  result: CompactionResult,
  branchEntries: readonly SessionEntry[],
): NonNullable<NonNullable<HookMap['before_compaction']['result']>['compaction']> {
  return {
    summary: result.summary,
    tokensBefore: result.tokensBefore,
    retainedTail: retainedTailFrom(branchEntries, result.firstKeptEntryId),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.details === undefined ? {} : { details: result.details as JsonValue }),
  };
}

function piBranchEntries(entries: readonly Entry[]): SessionEntry[] {
  return toPiSessionEntries(entries);
}

async function executePiTool(
  registered: RegisteredTool,
  runner: () => ExtensionRunner,
  isActive: (name: string) => boolean,
  toolCallId: string,
  parameters: unknown,
  signal: AbortSignal | undefined,
  onUpdate: ((result: DoomHeadlessToolResult) => void) | undefined,
): Promise<DoomHeadlessToolResult> {
  const definition = registered.definition;
  // Admission, not visibility. A cached definition must still be active when called.
  if (!isActive(definition.name)) throw new Error(`Tool '${definition.name}' is no longer active`);
  const prepared = definition.prepareArguments ? definition.prepareArguments(parameters) : parameters;
  const result = await definition.execute(
    toolCallId,
    prepared,
    signal,
    (partial) => onUpdate?.({ content: partial.content, details: partial.details }),
    runner().createContext(),
  );
  return { content: result.content, details: result.details };
}

function toHarnessTool(
  registered: RegisteredTool,
  runner: () => ExtensionRunner,
  isActive: (name: string) => boolean,
): AgentHarnessTool<object | undefined> {
  const definition = registered.definition;
  return {
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    async execute(toolCallId, parameters, onUpdate, _toolContext, _invocation, context) {
      const result = await executePiTool(
        registered,
        runner,
        isActive,
        toolCallId,
        parameters,
        context.abortSignal,
        (partial) => onUpdate({ content: partial.content, details: partial.details }),
      );
      return { content: result.content, details: result.details };
    },
  };
}

/**
 * Resolves the skills Pi extensions contribute.
 *
 * Pi wires this through AgentSession's resource loader, which the headless server does not use,
 * so the pipeline is rebuilt here against the harness. Pi's own loader parses and validates the
 * frontmatter; only the body has to be read, because Pi's Skill record carries a path where the
 * harness wants inline content.
 */
async function loadPiSkills(
  runner: ExtensionRunner,
  cwd: string,
  agentDir: string,
  onNotice: ((message: string) => void) | undefined,
): Promise<readonly Skill[]> {
  const discovered = await runner.emitResourcesDiscover(cwd, 'startup');
  if (discovered.skillPaths.length === 0) return [];

  const loaded = loadSkills({
    cwd,
    agentDir,
    skillPaths: discovered.skillPaths.map((entry) => entry.path),
    includeDefaults: false,
  });
  for (const diagnostic of loaded.diagnostics) onNotice?.(`Pi skill ${diagnostic.path}: ${diagnostic.message}`);

  const resolved: Skill[] = [];
  for (const skill of loaded.skills) {
    try {
      resolved.push({
        name: skill.name,
        description: skill.description,
        content: readFileSync(skill.filePath, 'utf8'),
        filePath: skill.filePath,
        ...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
      });
    } catch (error) {
      // One unreadable skill file must not cost the session every other skill.
      onNotice?.(`Pi skill ${skill.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return resolved;
}
/**
 * A SessionManager backed by the session the server already has open.
 *
 * Pi extensions read history through a SessionManager, which is JSONL backed, while the server
 * persists to SQLite through the harness. Rather than opening a second connection and taking a
 * second history lease, the manager is hydrated in memory from the live session and its writes
 * are mirrored back through the same harness runtime.
 *
 * `_persist` is public in Pi's source and in its shipped types, but it is not a documented
 * extension point, so the guard below turns a rename in a future Pi release into an immediate,
 * named failure instead of history that silently stops being recorded.
 */
/**
 * Pi's default theme, reached through public API only.
 *
 * The singleton lives in Pi's interactive theme module, which the package `exports` map does not
 * expose, so a deep import fails with ERR_PACKAGE_PATH_NOT_EXPORTED. A freshly constructed runner
 * still carries Pi's own no-op UI context, whose `theme` getter returns that singleton, so reading
 * it back before binding is the supported route. The getter throws until `initTheme` has run.
 */
function resolveDefaultTheme(runner: ExtensionRunner): ExtensionUIContext['theme'] {
  try {
    return runner.getUIContext().theme;
  } catch {
    // Not a failure: the theme singleton is lazily initialised and no TUI has done it here.
    initTheme(undefined, false);
    return runner.getUIContext().theme;
  }
}

/**
 * Pi's extension UI surface, backed by the headless client the server already speaks.
 *
 * Dialogs, notifications and status text have a real transport, so they are wired through. The
 * members that need a live TUI (custom components, widgets, footer, header, editor component,
 * autocomplete, terminal input, themes) have no headless equivalent and degrade to the same no-ops
 * Pi's own RPC mode uses, rather than throwing into extension code that checked `hasUI` first.
 */
function createHeadlessUiContext(
  client: () => DoomHeadlessClient | undefined,
  theme: ExtensionUIContext['theme'],
): ExtensionUIContext {
  const ask = async (request: DoomHeadlessClientRequest, signal?: AbortSignal): Promise<unknown> => {
    const target = client();
    if (target === undefined) return undefined;
    return await target.request(request, signal);
  };

  return {
    async select(title, options, opts) {
      const answer = await ask(
        { kind: 'select', title, options: options.map((option) => ({ label: option, value: option })) },
        opts?.signal,
      );
      return typeof answer === 'string' ? answer : undefined;
    },
    async confirm(title, message, opts) {
      return (await ask({ kind: 'confirm', title, message }, opts?.signal)) === true;
    },
    async input(title, _placeholder, opts) {
      // The headless request carries no placeholder field. Sending the hint as initialValue would
      // prefill the answer with it, so the hint is dropped rather than misrepresented.
      const answer = await ask({ kind: 'input', title }, opts?.signal);
      return typeof answer === 'string' ? answer : undefined;
    },
    async editor(title, prefill) {
      const answer = await ask({
        kind: 'input',
        title,
        multiline: true,
        ...(prefill === undefined ? {} : { initialValue: prefill }),
      });
      return typeof answer === 'string' ? answer : undefined;
    },
    notify(message, type) {
      // The notification schema requires a non-empty body.
      if (message.length === 0) return;
      void client()?.notify({ body: message, ...(type === undefined ? {} : { level: type }) });
    },
    setStatus(key, text) {
      client()?.setStatus(key, text);
    },
    pasteToEditor(text) {
      client()?.appendComposerText?.(text);
    },

    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    // Matches Pi's own RPC mode, which also resolves undefined because custom components need a TUI.
    custom: async <T>(): Promise<T> => undefined as T,
    setEditorText: () => {},
    getEditorText: () => '',
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Themes are not available in the headless server' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

interface BridgedSessionSync {
  append(entry: Entry): void;
  toHarnessId(entryId: string): string;
  toPiId(entryId: string | null): string | null;
}

const bridgedSessionSync = new WeakMap<SessionManager, BridgedSessionSync>();

export async function createBridgedSessionManager(
  runtime: DirectHarnessRuntime,
  cwd: string,
  onNotice?: (message: string) => void,
  /** The branch the caller has already read, so opening a session scans it once. */
  branchEntries?: readonly Entry[],
): Promise<SessionManager> {
  const metadata = runtime.session.metadata;
  const entries = branchEntries ?? (await runtime.readEntries()).entries;
  const header: PiSessionHeaderInput = {
    id: metadata.id,
    cwd: metadata.cwd ?? cwd,
    createdAt: metadata.createdAt,
    ...(metadata.parentSessionId === undefined ? {} : { parentSessionId: metadata.parentSessionId }),
  };

  const manager = SessionManager.inMemory(
    header.cwd,
    {
      id: metadata.id,
      ...(metadata.parentSessionId === undefined ? {} : { parentSession: metadata.parentSessionId }),
    },
    toPiFileEntries(header, entries),
  );

  if (typeof manager._persist !== 'function') {
    throw new Error("Pi's SessionManager no longer exposes '_persist'; the headless session bridge must be updated");
  }
  const append = (manager as unknown as { _appendEntry?: (entry: SessionEntry) => void })._appendEntry;
  if (typeof append !== 'function') {
    throw new Error("Pi's SessionManager no longer exposes '_appendEntry'; the live session bridge must be updated");
  }

  let syncingHarnessEntry = false;
  const pendingMirrors: Array<{
    readonly entry: SessionEntry;
    readonly mirrored: { customType: string; data: unknown };
  }> = [];
  const harnessToPiId = new Map<string, string>();
  const piToHarnessId = new Map<string, string>();
  const persist = manager._persist.bind(manager);
  manager._persist = (entry) => {
    persist(entry);
    if (syncingHarnessEntry) return;
    const mirrored = fromPiSessionEntry(entry);
    if (mirrored === undefined) return;
    const pending = { entry, mirrored };
    pendingMirrors.push(pending);
    void runtime.appendCustomEntry(mirrored.customType, mirrored.data).catch((error: unknown) => {
      const index = pendingMirrors.indexOf(pending);
      if (index !== -1) pendingMirrors.splice(index, 1);
      onNotice?.(
        `Pi session write for '${mirrored.customType}' was not mirrored: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const resolvePiId = (entryId: string | null): string | null => {
    if (entryId === null) return null;
    return harnessToPiId.get(entryId) ?? entryId;
  };
  bridgedSessionSync.set(manager, {
    append(entry) {
      if (manager.getEntry(entry.id) !== undefined) return;
      if (entry.type === 'custom') {
        const pendingIndex = pendingMirrors.findIndex(
          (pending) =>
            pending.mirrored.customType === entry.customType && isDeepStrictEqual(pending.mirrored.data, entry.data),
        );
        if (pendingIndex !== -1) {
          const pending = pendingMirrors.splice(pendingIndex, 1)[0];
          if (pending !== undefined) {
            harnessToPiId.set(entry.id, pending.entry.id);
            piToHarnessId.set(pending.entry.id, entry.id);
          }
          return;
        }
      }
      const converted =
        entry.type === 'compaction'
          ? toPiSessionEntry(entry, boundaryEntryId(manager.getBranch(), entry.retainedTail.length))
          : toPiSessionEntry(entry);
      if (converted === undefined) return;
      const parentId = resolvePiId(converted.parentId);
      syncingHarnessEntry = true;
      try {
        append.call(manager, parentId === converted.parentId ? converted : { ...converted, parentId });
      } finally {
        syncingHarnessEntry = false;
      }
    },
    toHarnessId: (entryId) => piToHarnessId.get(entryId) ?? entryId,
    toPiId: resolvePiId,
  });

  return manager;
}

export function createPiExtensionHost(options: PiExtensionHostOptions): PiExtensionHost {
  const { cwd, agentDir, models, runtime, preload } = options;
  let runner: ExtensionRunner | undefined;
  let sessionManager: SessionManager | undefined;
  let sessionSync: BridgedSessionSync | undefined;
  let tools: readonly AgentHarnessTool<object | undefined>[] = [];
  let skills: readonly Skill[] = [];
  let registered: readonly RegisteredTool[] = [];
  // Every registered name until a restriction narrows it. Seeded at load(), because an empty set
  // before load must not read as "everything is hidden".
  let activeNames = new Set<string>();
  let unsubscribeEvents: (() => void) | undefined;
  let unsubscribeLifecycle: (() => void) | undefined;
  let cordisConnection: DoomCordisHostConnection | undefined;

  // Pi's ExtensionContext getters are synchronous while every harness read is not, so the
  // facts they answer from are tracked off the harness event stream and primed from history.
  // Hot lifecycle events update only bounded, incremental state. No event rereads history.
  let contextTokens: number | null = null;
  let currentOperation: 'run' | 'compaction' | 'navigation' | null = null;
  let nativeQueuedMessages = 0;
  let retainedQueuedMessages = 0;
  let turnIndex = 0;
  let runMessages: AgentMessage[] = [];
  const toolArguments = new Map<string, unknown>();
  /** Whether the compaction now running came from a Pi extension rather than the harness. */
  let compactionFromExtension = false;
  /**
   * Set once shutdown begins. The session disposes its runtime before extensions see
   * session_shutdown, so tool changes made from that handler have no runtime to reach.
   */
  let shuttingDown = false;

  const report = (source: string, error: unknown): void =>
    options.onNotice?.(`Pi extension ${source}: ${error instanceof Error ? error.message : String(error)}`);

  const activeTools = (): readonly AgentHarnessTool<object | undefined>[] =>
    tools.filter((tool) => activeNames.has(tool.name));
  const requireRunner = (): ExtensionRunner => {
    if (runner === undefined) throw new Error('The Pi extension host is not loaded');
    return runner;
  };

  /**
   * Where one custom message goes, following Pi's own order in `sendCustomMessage`.
   *
   * An explicit `nextTurn` always queues; a running turn takes the message unless the
   * caller opted out; an idle agent is woken only when the caller asked for a turn.
   * Pi's remaining branch, deferring an append made mid-turn, needs no counterpart:
   * the lane already holds a write until the operation reaches a safe commit point.
   */
  const deliverMessage = (
    message: AgentMessage,
    sendOptions?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): Promise<unknown> => {
    if (sendOptions?.deliverAs === 'nextTurn') return runtime.nextRun(message);
    if (currentOperation === 'run' && sendOptions?.triggerTurn !== false) {
      return sendOptions?.deliverAs === 'followUp' ? runtime.followUp(message) : runtime.steer(message);
    }
    if (sendOptions?.triggerTurn === true) return runtime.admitMessage(message);
    return runtime.appendMessage(message);
  };

  const actions: ExtensionActions = {
    sendMessage: (message, sendOptions) => {
      const custom: Extract<AgentMessage, { role: 'custom' }> = {
        role: 'custom',
        customType: message.customType,
        // Untyped extensions can pass missing content; Pi normalizes it at the same point.
        content: message.content ?? [],
        display: message.display,
        ...(message.details === undefined ? {} : { details: message.details }),
        timestamp: Date.now(),
      };
      void deliverMessage(custom, sendOptions).catch((error: unknown) => report('send_message', error));
    },
    sendUserMessage: (content) => {
      void runtime
        .prompt(typeof content === 'string' ? content : JSON.stringify(content))
        .catch((error: unknown) => report('send_user_message', error));
    },
    appendEntry: (customType, data) => {
      void runtime.appendCustomEntry(customType, data).catch((error: unknown) => report('append_entry', error));
    },
    setSessionName: (name) => {
      void runtime.setName(name).catch((error: unknown) => report('set_session_name', error));
    },
    // Harness SessionMetadata carries no display name, and Pi allows this to be absent.
    getSessionName: () => undefined,
    setLabel: (entryId, label) => {
      void runtime
        .setLabel(sessionSync?.toHarnessId(entryId) ?? entryId, label)
        .catch((error: unknown) => report('set_label', error));
    },
    getActiveTools: () => activeTools().map((tool) => tool.name),
    getAllTools: (): ToolInfo[] =>
      registered.map((tool) => ({
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: tool.definition.parameters,
        ...(tool.definition.promptGuidelines === undefined
          ? {}
          : { promptGuidelines: tool.definition.promptGuidelines }),
        sourceInfo: tool.sourceInfo,
      })),
    // Backs DOOM_TOOL_SURFACE_SERVICE, which is the only way a Pi extension can hide its own
    // tools. Throwing here left every restriction inert and leaked mode-gated tools such as
    // narrate into sessions whose mode was off.
    setActiveTools: (names) => {
      const known = new Set(registered.map((tool) => tool.definition.name));
      activeNames = new Set(names.filter((name) => known.has(name)));
      if (!shuttingDown) options.onActiveToolsChanged?.();
    },
    refreshTools: () => {
      if (shuttingDown) return;
      void runtime.replaceTools([...activeTools()]).catch((error: unknown) => report('refresh_tools', error));
    },
    getCommands: () => [],
    setModel: async (model) => {
      await runtime.setModel({ provider: model.provider, id: model.id });
      return true;
    },
    getThinkingLevel: () => options.getThinkingLevel(),
    setThinkingLevel: (level) => {
      void runtime.setThinkingLevel(level).catch((error: unknown) => report('set_thinking_level', error));
    },
  };

  const contextActions: ExtensionContextActions = {
    getModel: () => options.getModel(),
    getScopedModels: () => [],
    // Mirrors the server's own readState: a tree navigation is not a turn, so it does not
    // make the agent busy.
    isIdle: () => currentOperation !== 'run' && currentOperation !== 'compaction',
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {
      void runtime.abort().catch((error: unknown) => report('abort', error));
    },
    // Queued writes are excluded. An extension's own deferred append is not a message the
    // model is waiting on, and counting it would stall every extension that waits for a
    // quiet queue before acting.
    hasPendingMessages: () => nativeQueuedMessages > 0 || retainedQueuedMessages > 0,
    shutdown: () => {
      runtime.stop();
    },
    getContextUsage: () => contextUsageOf(contextTokens, options.getModel()?.contextWindow),
    compact: () => {
      void runtime.compact().catch((error: unknown) => report('compact', error));
    },
    getSystemPrompt: () => '',
  };

  const piCompactionEntry = async (entryId: string): Promise<CompactionEntry | undefined> => {
    const { entries } = await runtime.readEntries();
    const converted = toPiSessionEntries(entries).find((entry) => entry.id === entryId);
    return converted?.type === 'compaction' ? converted : undefined;
  };

  const turnBoundaryContext = (): BoundaryContextPreview => {
    const projection = sessionManager?.buildSessionProjection();
    const contextEntries = projection?.entries ?? [];
    const contextMessages = projection?.messages ?? [];
    return {
      contextEntries,
      contextMessages,
      llmMessages: contextMessages.filter((message): message is Message => message.role !== 'bashExecution'),
      pendingMessages: [],
      canContinue: contextMessages.at(-1)?.role !== 'assistant',
    };
  };

  /** Harness events, translated into Pi events in AgentSession order. */
  const handleHarnessEvent = async (event: HarnessEvent): Promise<void> => {
    switch (event.type) {
      case 'run_start':
        currentOperation = 'run';
        turnIndex = 0;
        runMessages = [];
        toolArguments.clear();
        await runner?.emit({ type: 'agent_start' });
        return;
      case 'run_resume':
        currentOperation = 'run';
        return;
      case 'turn_start':
        await runner?.emit({ type: 'turn_start', turnIndex, timestamp: Date.now() });
        return;
      case 'message_start':
        await runner?.emit({ type: 'message_start', message: event.message });
        return;
      case 'message_update':
        await runner?.emit({
          type: 'message_update',
          message: event.message,
          assistantMessageEvent: event.event,
        });
        return;
      case 'message_end':
        if (event.runId !== undefined) runMessages.push(event.message);
        if (event.message.role === 'assistant') contextTokens = contextTokensOf(event.message.usage);
        // Harness persistence has already committed at this boundary, so replacement results cannot
        // be honored faithfully. The handler still observes the same lifecycle boundary.
        await runner?.emitMessageEnd({ type: 'message_end', message: event.message });
        return;
      case 'tool_start':
        toolArguments.set(event.toolCallId, event.args);
        await runner?.emit({
          type: 'tool_execution_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        return;
      case 'tool_update':
        await runner?.emit({
          type: 'tool_execution_update',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: toolArguments.get(event.toolCallId),
          partialResult: event.partialResult,
        });
        return;
      case 'tool_end':
        toolArguments.delete(event.toolCallId);
        await runner?.emit({
          type: 'tool_execution_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
        return;
      case 'entry_added':
        sessionSync?.append(event.entry);
        return;
      case 'queue_update':
        nativeQueuedMessages = event.queues.filter((item) => item.kind !== 'write').length;
        return;
      case 'turn_end': {
        const branch = sessionManager?.getBranch() ?? [];
        // The harness commits a fresh entry after message_end (and may normalize the message
        // during settlement), so its entry_added payload need not share the event's identity.
        // A turn ends at the latest persisted assistant on this branch.
        const messageEntryId = branch.findLast(
          (entry) => entry.type === 'message' && entry.message.role === 'assistant',
        )?.id;
        if (messageEntryId === undefined) {
          report('turn_end', new Error('The persisted assistant entry was not available for the Pi boundary'));
          turnIndex += 1;
          return;
        }
        const toolResultEntryIds = event.toolResults.flatMap((result) => {
          const entryId = branch.findLast(
            (entry) =>
              entry.type === 'message' &&
              entry.message.role === 'toolResult' &&
              entry.message.toolCallId === result.toolCallId,
          )?.id;
          return entryId === undefined ? [] : [entryId];
        });
        await runner?.emitBoundary(
          {
            type: 'turn_end',
            turnIndex,
            message: event.message,
            toolResults: event.toolResults,
            messageEntryId,
            toolResultEntryIds,
            outcome:
              event.message.stopReason === 'aborted'
                ? 'aborted'
                : event.message.stopReason === 'error'
                  ? 'error'
                  : 'completed',
          },
          turnBoundaryContext,
        );
        turnIndex += 1;
        return;
      }
      case 'run_end':
        currentOperation = null;
        await runner?.emit({ type: 'agent_end', messages: runMessages });
        await runner?.emit({ type: 'agent_settled' });
        runMessages = [];
        toolArguments.clear();
        return;
      case 'compaction_start':
        currentOperation = 'compaction';
        return;
      case 'compaction_end': {
        currentOperation = null;
        const fromExtension = compactionFromExtension;
        compactionFromExtension = false;
        if (event.status !== 'completed') {
          await runner?.emit({
            type: 'session_compact_failed',
            reason: event.reason,
            ...(event.status === 'failed' ? { errorMessage: event.error.message } : {}),
            aborted: event.status === 'aborted',
            willRetry: event.reason === 'overflow',
            fromExtension,
          });
          return;
        }
        // Usage measured against the pre-compaction context no longer describes this one.
        contextTokens = null;
        const compactionEntry = await piCompactionEntry(event.entryId);
        if (compactionEntry === undefined) return;
        await runner?.emit({
          type: 'session_compact',
          compactionEntry,
          fromExtension,
          reason: event.reason,
          // Overflow is the only reason the harness compacts to retry a turn it had to abort.
          willRetry: event.reason === 'overflow',
        });
        return;
      }
      case 'navigation_start':
        currentOperation = 'navigation';
        return;
      case 'navigation_end': {
        currentOperation = null;
        if (event.status !== 'completed') return;
        const newLeafId = sessionSync?.toPiId(event.tipId) ?? event.tipId;
        const oldLeafId = sessionSync?.toPiId(event.fromTipId) ?? event.fromTipId;
        if (newLeafId === null) sessionManager?.resetLeaf();
        else if (sessionManager?.getEntry(newLeafId) !== undefined) sessionManager.branch(newLeafId);
        const leaf = newLeafId === null ? undefined : sessionManager?.getEntry(newLeafId);
        await runner?.emit({
          type: 'session_tree',
          newLeafId,
          oldLeafId,
          ...(leaf?.type === 'branch_summary' ? { summaryEntry: leaf } : {}),
        });
        return;
      }
      case 'value_update':
        if (event.value === 'session_name') {
          await runner?.emit({ type: 'session_info_changed', name: event.name });
        }
        return;
      case 'config_update':
        if (event.property === 'model') {
          const model = models.getModel(event.value.provider, event.value.modelId);
          const previous = event.previous as { provider?: unknown; modelId?: unknown } | undefined;
          const previousModel =
            typeof previous?.provider === 'string' && typeof previous.modelId === 'string'
              ? models.getModel(previous.provider, previous.modelId)
              : undefined;
          if (model !== undefined) await runner?.emit({ type: 'model_select', model, previousModel, source: 'set' });
        } else if (event.property === 'thinkingLevel') {
          await runner?.emit({
            type: 'thinking_level_select',
            level: event.value,
            previousLevel: event.previous,
          });
        }
        return;
      default:
        return;
    }
  };

  // An extension that throws must not fault the lane, so the rejection is reported here and
  // the harness sees a settled listener.
  const onHarnessEvent = (event: HarnessEvent): Promise<void> =>
    handleHarnessEvent(event).catch((error: unknown) => report(`event '${event.type}'`, error));

  const transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> =>
    runner === undefined ? messages : runner.emitContext(messages);

  const beforeCompaction = async (
    event: HookMap['before_compaction']['event'],
  ): Promise<HookMap['before_compaction']['result']> => {
    if (runner === undefined) return undefined;
    const branchEntries = piBranchEntries((await runtime.readEntries()).entries);
    const result = await runner.emit({
      type: 'session_before_compact',
      preparation: toPiCompactionPreparation(event.preparation, branchEntries),
      branchEntries,
      ...(event.customInstructions === undefined ? {} : { customInstructions: event.customInstructions }),
      reason: event.reason,
      willRetry: event.reason === 'overflow',
      // The harness exposes no per-compaction signal. A handler that checks this sees an
      // accurate "not aborted" at the moment it runs; only a long handler misses a later abort.
      signal: new AbortController().signal,
    });
    if (result?.cancel === true) return { decline: true };
    if (result?.compaction === undefined) return undefined;
    compactionFromExtension = true;
    return { compaction: toHarnessCompactResult(result.compaction, branchEntries) };
  };

  return {
    transformContext,
    beforeCompaction,
    get tools() {
      return activeTools();
    },

    get toolGuidance(): readonly ToolPromptEntry[] {
      // Filtered alongside `tools`: guidance for a hidden tool would otherwise keep instructing the
      // model to call something it cannot see.
      return registered
        .filter((tool) => activeNames.has(tool.definition.name))
        .map((tool) => ({
          name: tool.definition.name,
          ...(tool.definition.promptSnippet === undefined ? {} : { promptSnippet: tool.definition.promptSnippet }),
          ...(tool.definition.promptGuidelines === undefined
            ? {}
            : { promptGuidelines: tool.definition.promptGuidelines }),
        }));
    },

    get skills() {
      return skills;
    },

    getService<T>(name: string): T | undefined {
      return cordisConnection?.root.get(name) as T | undefined;
    },
    executeTool(name, toolCallId, parameters, signal, onUpdate) {
      const tool = registered.find((entry) => entry.definition.name === name);
      if (tool === undefined) throw new Error(`Unknown Pi extension tool '${name}'`);
      return executePiTool(
        tool,
        requireRunner,
        (candidate) => activeNames.has(candidate),
        toolCallId,
        parameters,
        signal,
        onUpdate,
      );
    },

    async load(): Promise<void> {
      if (runner !== undefined) throw new Error('The Pi extension host was loaded more than once');
      if (preload === undefined) return;

      const { entries } = await runtime.readEntries();
      // A resumed session has already spent context that no future event will re-announce,
      // so the counter starts from what history measured rather than from zero.
      contextTokens = contextTokensOf(latestAssistantUsage(entries));

      const loaded: Extension[] = [...preload.extensions];

      sessionManager = await createBridgedSessionManager(runtime, cwd, options.onNotice, entries);
      const manager = sessionManager;
      sessionSync = bridgedSessionSync.get(manager);
      if (sessionSync === undefined) throw new Error('The live Pi session bridge was not initialized');

      runner = new ExtensionRunner(loaded, preload.runtime, cwd, manager, new ModelRegistry(models));
      // 'rpc' is the accurate mode for a server with no terminal, and it must be set before any
      // extension runs. Provider registrations were already drained against this same ModelRuntime
      // by preloadPiExtensions, so bindCore finds an empty queue here.
      runner.setUIContext(createHeadlessUiContext(options.client, resolveDefaultTheme(runner)), 'rpc');
      runner.bindCore(actions, contextActions);

      registered = loaded.flatMap((extension) => [...extension.tools.values()]);
      tools = registered.map((tool) => toHarnessTool(tool, requireRunner, (name) => activeNames.has(name)));
      activeNames = new Set(tools.map((tool) => tool.name));
      // Subscribe before extension lifecycle handlers run: those handlers may write history,
      // and missing their entry_added acknowledgement would permanently stale this mirror.
      unsubscribeEvents = runtime.onEvent(onHarnessEvent);
      const initialLifecycle = await runtime.readLifecycle();
      currentOperation = initialLifecycle.operation?.kind ?? null;
      nativeQueuedMessages = Number((await runtime.readState()).pendingMessageCount) || 0;
      retainedQueuedMessages = initialLifecycle.queue.length;
      unsubscribeLifecycle = runtime.onPresentationFrame((frame) => {
        if (frame.type !== 'lifecycle_update' || !frame.lifecycle || typeof frame.lifecycle !== 'object') return;
        const lifecycle = frame.lifecycle as Awaited<ReturnType<typeof runtime.readLifecycle>>;
        retainedQueuedMessages = lifecycle.queue.length;
        currentOperation = lifecycle.operation?.kind ?? null;
      });
      // Pi opens session-scoped extension services before resource discovery. Doom tool
      // restrictions depend on the same ordering.
      await runner.emit({ type: 'session_start', reason: 'startup' });
      if (preload.events !== undefined)
        cordisConnection = await connectDoomCordisHost({ events: preload.events }, 'headless-pi-extension-host');
      skills = await loadPiSkills(runner, cwd, agentDir, options.onNotice);
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
      unsubscribeLifecycle?.();
      unsubscribeLifecycle = undefined;
      sessionSync = undefined;
      sessionManager = undefined;
      runMessages = [];
      toolArguments.clear();
      const connection = cordisConnection;
      cordisConnection = undefined;
      try {
        if (runner !== undefined) await runner.emit({ type: 'session_shutdown', reason: 'quit' });
      } finally {
        await connection?.dispose();
      }
    },
  };
}
