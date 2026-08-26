import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { connectDoomCordisHost, type DoomCordisHostConnection } from '../pi/cordisHost.ts';

/**
 * A Pi host a test drives, in place of the one Pi builds at runtime.
 *
 * Every extension package needs one, and before this each wrote its own as an
 * `as unknown as ExtensionAPI` cast over the four or five members that package
 * happened to call. A cast type-checks whatever Pi's interface becomes, so the
 * casts all kept passing while diverging from each other and from Pi.
 *
 * `pi` here is a plain `ExtensionAPI`, assigned without a cast. When a Pi
 * upgrade adds or reshapes a member, this file stops compiling, which is the
 * whole point: one place to notice, instead of ninety places that never do.
 *
 * `ExtensionContext` cannot be held to the same standard and is built with one
 * cast, named at the site. Three of its members are unsatisfiable by an object
 * literal: `modelRegistry` is a class with a private field, so it is nominally
 * typed; `ui.theme` is typed from a module Pi does not export; and `model` is
 * a populated provider record no test asserts on. The context is otherwise
 * built member by member, and the surface extensions actually program against,
 * `ExtensionAPI`, carries no cast at all.
 */

/**
 * Every handler Pi's 34 `on` overloads accept, stored as one.
 *
 * `never` in the parameter positions is what makes all 34 assignable: a handler
 * is only accepted where the stored type asks for less than the handler does.
 * The consequence is that a stored handler cannot be called without widening it
 * back, which `invokable` does once, below. No single type both accepts every
 * overload and is callable with an arbitrary payload.
 */
type LifecycleHandler = (event: never, context: never) => unknown;
/** One stored handler, widened at the single point that calls it. */
type InvokableHandler = (event: unknown, context: unknown) => unknown;

function invokable(handler: LifecycleHandler): InvokableHandler {
  return handler as InvokableHandler;
}

/** Types Pi declares but does not re-export from its package root. */
type SessionManagerView = ExtensionContext['sessionManager'];
type RunMode = ExtensionContext['mode'];
type ShortcutId = Parameters<ExtensionAPI['registerShortcut']>[0];
type ShortcutOptions = Parameters<ExtensionAPI['registerShortcut']>[1];
type CommandOptions = Parameters<ExtensionAPI['registerCommand']>[1];
type FlagOptions = Parameters<ExtensionAPI['registerFlag']>[1];
type CustomMessagePayload = Parameters<ExtensionAPI['sendMessage']>[0];
type SendMessageOptions = Parameters<ExtensionAPI['sendMessage']>[1];
type UserMessageContent = Parameters<ExtensionAPI['sendUserMessage']>[0];
type SendUserMessageOptions = Parameters<ExtensionAPI['sendUserMessage']>[1];
type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0];
type ToolUpdateCallback = Parameters<RegisteredTool['execute']>[3];
type ExecutionResult = Awaited<ReturnType<ExtensionAPI['exec']>>;
type ExecutionOptions = Parameters<ExtensionAPI['exec']>[2];
type ThinkingLevelValue = ReturnType<ExtensionAPI['getThinkingLevel']>;
type WidgetContent = Parameters<ExtensionContext['ui']['setWidget']>[1];

export interface RecordedCommand {
  name: string;
  options: CommandOptions;
}
export interface RecordedShortcut {
  shortcut: ShortcutId;
  options: ShortcutOptions;
}
export interface RecordedRenderer {
  customType: string;
  renderer: unknown;
}
/** A `registerProvider` call in either of its two shapes. */
export interface RecordedProvider {
  /** Present for the `(name, config)` overload. */
  name?: string;
  value: unknown;
}
export interface RecordedMessage {
  message: CustomMessagePayload;
  options: SendMessageOptions;
}
export interface RecordedUserMessage {
  content: UserMessageContent;
  options: SendUserMessageOptions;
}
export interface RecordedEntry {
  customType: string;
  data: unknown;
}
export interface RecordedExec {
  command: string;
  args: string[];
  options: ExecutionOptions;
}
export interface RecordedNotification {
  sessionId: string;
  message: string;
  level: 'info' | 'warning' | 'error' | undefined;
}
export interface RecordedWidget {
  sessionId: string;
  key: string;
  content: WidgetContent;
}
export interface RecordedStatus {
  sessionId: string;
  key: string;
  text: string | undefined;
}

/**
 * What the extension's dialogs answer.
 *
 * Every default is the dismissal, because that is the answer a headless host
 * gives and the one an extension is most likely to mishandle.
 */
export interface PiTestDialogAnswers {
  select(title: string, options: string[]): string | undefined;
  confirm(title: string, message: string): boolean;
  input(title: string, placeholder: string | undefined): string | undefined;
  editor(title: string, prefill: string | undefined): string | undefined;
}

export interface PiTestContextOptions {
  sessionId?: string;
  cwd?: string;
  hasUI?: boolean;
  mode?: RunMode;
  isIdle?: boolean;
  isProjectTrusted?: boolean;
  signal?: AbortSignal;
  answers?: Partial<PiTestDialogAnswers>;
  systemPrompt?: string;
}

export interface PiTestHostOptions extends PiTestContextOptions {
  /** Answers `pi.exec`; the default reports a command that ran and printed nothing. */
  exec?: (command: string, args: string[]) => ExecutionResult | Promise<ExecutionResult>;
}

export interface PiTestHost {
  /** The host an extension factory receives. */
  readonly pi: ExtensionAPI;
  readonly tools: readonly RegisteredTool[];
  readonly commands: readonly RecordedCommand[];
  readonly shortcuts: readonly RecordedShortcut[];
  readonly flags: ReadonlyMap<string, FlagOptions>;
  readonly messageRenderers: readonly RecordedRenderer[];
  readonly entryRenderers: readonly RecordedRenderer[];
  readonly markdownTransformers: readonly unknown[];
  readonly providers: readonly RecordedProvider[];
  readonly unregisteredProviders: readonly string[];
  readonly messages: readonly RecordedMessage[];
  readonly userMessages: readonly RecordedUserMessage[];
  readonly entries: readonly RecordedEntry[];
  readonly execs: readonly RecordedExec[];
  readonly notifications: readonly RecordedNotification[];
  readonly statuses: readonly RecordedStatus[];
  readonly widgets: readonly RecordedWidget[];
  /** Tool names Pi would offer the model right now. */
  activeTools(): readonly string[];
  tool(name: string): RegisteredTool | undefined;
  command(name: string): RecordedCommand | undefined;
  /** Lifecycle handlers registered for one event, in registration order. */
  handlers(event: string): readonly InvokableHandler[];
  /** A context for this host; each call builds a fresh one, as Pi does per event. */
  context(options?: PiTestContextOptions): ExtensionContext;
  /**
   * Runs every handler for one lifecycle event and returns what they answered.
   *
   * Sequential and awaited, matching Pi, so a test can observe one handler's
   * effect on the next.
   */
  emit(event: string, payload?: unknown, context?: ExtensionContext): Promise<unknown[]>;
  /** Calls a registered tool the way Pi's runner does. */
  callTool(
    name: string,
    params?: unknown,
    options?: {
      toolCallId?: string;
      signal?: AbortSignal;
      onUpdate?: ToolUpdateCallback;
      context?: ExtensionContext;
    },
  ): Promise<unknown>;
  /** Runs a registered slash command the way Pi's palette does. */
  runCommand(name: string, args?: string, context?: ExtensionContext): Promise<void>;
  /** The real Cordis host on this runner, installed on first use and disposed by `dispose`. */
  cordis(source?: string): Promise<DoomCordisHostConnection>;
  dispose(): Promise<void>;
}

const DEFAULT_CWD = '/repo';
const DEFAULT_SESSION_ID = 'test-session';
const DEFAULT_MODE: RunMode = 'tui';
const DEFAULT_SYSTEM_PROMPT = '';
const DEFAULT_CORDIS_SOURCE = 'pi-test-host';
const DEFAULT_EXEC: ExecutionResult = { code: 0, killed: false, stdout: '', stderr: '' };

const DISMISSED: PiTestDialogAnswers = {
  select: () => undefined,
  confirm: () => false,
  input: () => undefined,
  editor: () => undefined,
};

/**
 * A Pi host and the records of what an extension did to it.
 *
 * Nothing here is a spy from a test framework: the records are plain arrays, so
 * the harness works under any runner and adds no dependency to a package that
 * every extension already installs.
 */
export function createPiTestHost(options: PiTestHostOptions = {}): PiTestHost {
  const tools: RegisteredTool[] = [];
  const commands: RecordedCommand[] = [];
  const shortcuts: RecordedShortcut[] = [];
  const flags = new Map<string, FlagOptions>();
  const messageRenderers: RecordedRenderer[] = [];
  const entryRenderers: RecordedRenderer[] = [];
  const markdownTransformers: unknown[] = [];
  const providers: RecordedProvider[] = [];
  const unregisteredProviders: string[] = [];
  const messages: RecordedMessage[] = [];
  const userMessages: RecordedUserMessage[] = [];
  const entries: RecordedEntry[] = [];
  const execs: RecordedExec[] = [];
  const notifications: RecordedNotification[] = [];
  const statuses: RecordedStatus[] = [];
  const widgets: RecordedWidget[] = [];

  const lifecycle = new Map<string, LifecycleHandler[]>();
  const channels = new Map<string, Set<(data: unknown) => void>>();
  let activeToolNames: string[] = [];
  let sessionName: string | undefined;
  let thinkingLevel: ThinkingLevelValue = 'off';
  let cordisConnection: DoomCordisHostConnection | undefined;

  const runExec = options.exec ?? ((): ExecutionResult => DEFAULT_EXEC);

  const pi: ExtensionAPI = {
    on(event: string, handler: LifecycleHandler): void {
      const registered = lifecycle.get(event) ?? [];
      registered.push(handler);
      lifecycle.set(event, registered);
    },
    // Generic exactly as Pi declares it. Storage erases the schema generics; the
    // signature is the half that has to keep matching.
    registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
      tool: ToolDefinition<TParams, TDetails, TState>,
    ): void {
      tools.push(tool as unknown as RegisteredTool);
      activeToolNames.push(tool.name);
    },
    registerCommand(name: string, commandOptions: CommandOptions): void {
      commands.push({ name, options: commandOptions });
    },
    registerShortcut(shortcut: ShortcutId, shortcutOptions: ShortcutOptions): void {
      shortcuts.push({ shortcut, options: shortcutOptions });
    },
    registerFlag(name: string, flagOptions: FlagOptions): void {
      flags.set(name, flagOptions);
    },
    getFlag(name: string): boolean | string | undefined {
      return flags.get(name)?.default;
    },
    registerMessageRenderer(customType: string, renderer: unknown): void {
      messageRenderers.push({ customType, renderer });
    },
    registerMarkdownTransformer(transformer: unknown): void {
      markdownTransformers.push(transformer);
    },
    registerEntryRenderer(customType: string, renderer: unknown): void {
      entryRenderers.push({ customType, renderer });
    },
    sendMessage(message: CustomMessagePayload, sendOptions?: SendMessageOptions): void {
      messages.push({ message, options: sendOptions });
    },
    sendUserMessage(content: UserMessageContent, sendOptions?: SendUserMessageOptions): void {
      userMessages.push({ content, options: sendOptions });
    },
    appendEntry(customType: string, data?: unknown): void {
      entries.push({ customType, data });
    },
    setSessionName(name: string): void {
      sessionName = name;
    },
    getSessionName(): string | undefined {
      return sessionName;
    },
    setLabel(): void {
      // Labels are session bookmarks; no DoomPi extension reads them back.
    },
    async exec(command: string, args: string[], execOptions?: ExecutionOptions): Promise<ExecutionResult> {
      execs.push({ command, args, options: execOptions });
      return runExec(command, args);
    },
    getActiveTools(): string[] {
      return [...activeToolNames];
    },
    getAllTools(): never[] {
      // Pi's inventory folds in built-in and MCP tools this host has none of.
      return [];
    },
    setActiveTools(toolNames: string[]): void {
      activeToolNames = [...toolNames];
    },
    getCommands(): never[] {
      return [];
    },
    async setModel(): Promise<boolean> {
      // No API key is configured, which is the answer Pi gives for the same reason.
      return false;
    },
    getThinkingLevel(): ThinkingLevelValue {
      return thinkingLevel;
    },
    setThinkingLevel(level: ThinkingLevelValue): void {
      thinkingLevel = level;
    },
    registerProvider(providerOrName: unknown, config?: unknown): void {
      providers.push(
        typeof providerOrName === 'string' ? { name: providerOrName, value: config } : { value: providerOrName },
      );
    },
    unregisterProvider(name: string): void {
      unregisteredProviders.push(name);
    },
    events: {
      emit(channel: string, data: unknown): void {
        // A snapshot: a listener that unsubscribes on delivery would otherwise
        // reshape the set this loop is walking.
        const delivered = [...(channels.get(channel) ?? [])];
        for (const listener of delivered) listener(data);
      },
      on(channel: string, listener: (data: unknown) => void): () => void {
        const listeners = channels.get(channel) ?? new Set<(data: unknown) => void>();
        listeners.add(listener);
        channels.set(channel, listeners);
        return () => listeners.delete(listener);
      },
    },
  };

  function buildContext(contextOptions: PiTestContextOptions = {}): ExtensionContext {
    const sessionId = contextOptions.sessionId ?? options.sessionId ?? DEFAULT_SESSION_ID;
    const cwd = contextOptions.cwd ?? options.cwd ?? DEFAULT_CWD;
    const answers = { ...DISMISSED, ...options.answers, ...contextOptions.answers };
    const sessionManager = {
      getCwd: () => cwd,
      getSessionId: () => sessionId,
      getSessionName: () => sessionName,
      getSessionDir: () => cwd,
      getSessionFile: () => `${cwd}/${sessionId}.jsonl`,
      getLeafId: () => undefined,
      getLeafEntry: () => undefined,
      getEntry: () => undefined,
      getLabel: () => undefined,
      getBranch: () => [],
      buildContextEntries: () => [],
      getHeader: () => undefined,
      getEntries: () => [],
      getTree: () => [],
    };
    const ui = {
      select: async (title: string, selectOptions: string[]) => answers.select(title, selectOptions),
      confirm: async (title: string, message: string) => answers.confirm(title, message),
      input: async (title: string, placeholder?: string) => answers.input(title, placeholder),
      editor: async (title: string, prefill?: string) => answers.editor(title, prefill),
      notify: (message: string, level?: 'info' | 'warning' | 'error') => {
        notifications.push({ sessionId, message, level });
      },
      onTerminalInput: () => () => undefined,
      setStatus: (key: string, text: string | undefined) => {
        statuses.push({ sessionId, key, text });
      },
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: (key: string, content: WidgetContent) => {
        widgets.push({ sessionId, key, content });
      },
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      // A custom component needs a real TUI to resolve, so it never does. An
      // extension awaiting one must stay responsive, which is what this proves.
      custom: () => new Promise<never>(() => undefined),
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => '',
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      theme: undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'This host renders nothing.' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    };
    const context = {
      ui,
      mode: contextOptions.mode ?? options.mode ?? DEFAULT_MODE,
      hasUI: contextOptions.hasUI ?? options.hasUI ?? true,
      cwd,
      sessionManager: sessionManager as unknown as SessionManagerView,
      modelRegistry: undefined,
      model: undefined,
      scopedModels: [],
      isIdle: () => contextOptions.isIdle ?? options.isIdle ?? true,
      isProjectTrusted: () => contextOptions.isProjectTrusted ?? options.isProjectTrusted ?? true,
      signal: contextOptions.signal ?? options.signal,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => contextOptions.systemPrompt ?? options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      // Command handlers receive the wider context, and an extension that only
      // reads it should not have to be handed a second fixture to be exercised.
      getSystemPromptOptions: () => ({}),
      waitForIdle: async () => undefined,
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => undefined,
    };
    // The one cast. `modelRegistry` is a class with a private field and so is
    // nominally typed, `ui.theme` is typed from a module Pi does not export,
    // and `model` is a populated provider record. No object literal can satisfy
    // those three, and no DoomPi extension reads them.
    return context as unknown as ExtensionContext;
  }

  return {
    pi,
    tools,
    commands,
    shortcuts,
    flags,
    messageRenderers,
    entryRenderers,
    markdownTransformers,
    providers,
    unregisteredProviders,
    messages,
    userMessages,
    entries,
    execs,
    notifications,
    statuses,
    widgets,
    activeTools: () => [...activeToolNames],
    tool: (name) => tools.find((candidate) => candidate.name === name),
    command: (name) => commands.find((candidate) => candidate.name === name),
    handlers: (event) => (lifecycle.get(event) ?? []).map(invokable),
    context: buildContext,
    async emit(event, payload, context) {
      const eventContext = context ?? buildContext();
      const answered: unknown[] = [];
      // A snapshot, because a handler may register another for the same event
      // and Pi does not deliver this emission to it.
      const delivered = [...(lifecycle.get(event) ?? [])];
      for (const handler of delivered) {
        answered.push(await invokable(handler)({ type: event, ...(payload as object) }, eventContext));
      }
      return answered;
    },
    async callTool(name, params = {}, callOptions = {}) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`No tool named '${name}' is registered on this host.`);
      return tool.execute(
        callOptions.toolCallId ?? `call-${String(tools.indexOf(tool))}`,
        params,
        callOptions.signal,
        callOptions.onUpdate,
        callOptions.context ?? buildContext(),
      );
    },
    async runCommand(name, args = '', context) {
      const command = commands.find((candidate) => candidate.name === name);
      if (!command) throw new Error(`No command named '${name}' is registered on this host.`);
      await command.options.handler(args, (context ?? buildContext()) as never);
    },
    async cordis(source = DEFAULT_CORDIS_SOURCE) {
      cordisConnection ??= await connectDoomCordisHost(pi, source);
      return cordisConnection;
    },
    async dispose() {
      await cordisConnection?.dispose();
      cordisConnection = undefined;
    },
  };
}
