import type { PiPluginContributions } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import {
  DOOM_ASK_USER_BLOCKED_EVENT,
  DOOM_ASK_USER_PROMPT_EVENT,
} from '@agimon-ai/doompi-extension-contracts/ask-user';
import {
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_NOTIFICATION_SERVICE,
  type DoomNotificationLevel,
} from '@agimon-ai/doompi-extension-contracts/notification';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import {
  askUserPromptBody,
  supportsShellTitle,
  warrantsAttentionNotification,
  warrantsSettledNotification,
} from '../services/notificationPolicy';
import { attentionNotification, promptTitle, settledNotification, shellTabTitle } from '../services/notificationText';
import type { ShellTitleController, WriteTitle } from '../types/notifications';
import { createDoomNotificationRouter } from './notificationRouter';
import { createWorkerTitleController } from './shellTitleController';

const AGENT_SETTLED_EVENT = 'agent_settled';
const AGENT_START_EVENT = 'agent_start';
const EXTENSION_INPUT_SOURCE = 'extension';
const INPUT_EVENT = 'input';
const SESSION_START_EVENT = 'session_start';

export interface NotificationExtensionOptions {
  /** Replaces the worker-thread animator, which a host without worker threads cannot start. */
  titleController?: ShellTitleController;
  environment?: NodeJS.ProcessEnv;
}

/** Where the tab title is written, remembered so shutdown can restore it without an event. */
interface TitleSurface {
  cwd: string;
  write: WriteTitle;
}

type WrappedUiMethod = 'confirm' | 'editor' | 'input' | 'notify' | 'select';

const ORIGINAL_UI_METHOD = Symbol.for('@agimon-ai/doompi-notification/original-ui-method');

/** Capture the true host method even when another bundle copy currently owns the UI. */
function captureUiMethod<Method extends WrappedUiMethod>(
  ui: ExtensionUIContext,
  method: Method,
): ExtensionUIContext[Method] {
  let captured: unknown = ui[method];
  const seen = new Set<unknown>();
  while (typeof captured === 'function' && !seen.has(captured)) {
    seen.add(captured);
    const original = Reflect.get(captured, ORIGINAL_UI_METHOD) as unknown;
    if (typeof original !== 'function') break;
    captured = original;
  }
  return captured as ExtensionUIContext[Method];
}

function tagUiWrapper(wrapper: object, original: object): void {
  Reflect.defineProperty(wrapper, ORIGINAL_UI_METHOD, {
    configurable: false,
    enumerable: false,
    value: original,
    writable: false,
  });
}

/**
 * Routes UI notices and announces dialogs the agent opens on its own initiative.
 * Dialog wrappers preserve the original behavior. The notice wrapper replaces
 * host delivery while this plugin owns the UI and restores its exact identity.
 */
function wrapUiNotifications(
  ui: ExtensionUIContext,
  isActive: () => boolean,
  shouldNotifyAttention: () => boolean,
  notifyAttention: (body: string) => void,
  notify: (body: string, level?: DoomNotificationLevel) => void,
): () => void {
  const originalConfirm = captureUiMethod(ui, 'confirm');
  const wrappedConfirm: ExtensionUIContext['confirm'] = (title, message, options) => {
    if (shouldNotifyAttention()) notifyAttention(`${title}: ${message}`);
    return originalConfirm.call(ui, title, message, options);
  };
  tagUiWrapper(wrappedConfirm, originalConfirm);
  ui.confirm = wrappedConfirm;

  const originalSelect = captureUiMethod(ui, 'select');
  const wrappedSelect: ExtensionUIContext['select'] = (title, options, dialogOptions) => {
    if (shouldNotifyAttention()) notifyAttention(title);
    return originalSelect.call(ui, title, options, dialogOptions);
  };
  tagUiWrapper(wrappedSelect, originalSelect);
  ui.select = wrappedSelect;

  const originalInput = captureUiMethod(ui, 'input');
  const wrappedInput: ExtensionUIContext['input'] = (title, placeholder, options) => {
    if (shouldNotifyAttention()) notifyAttention(title);
    return originalInput.call(ui, title, placeholder, options);
  };
  tagUiWrapper(wrappedInput, originalInput);
  ui.input = wrappedInput;

  const originalEditor = captureUiMethod(ui, 'editor');
  const wrappedEditor: ExtensionUIContext['editor'] = (title, prefill) => {
    if (shouldNotifyAttention()) notifyAttention(title);
    return originalEditor.call(ui, title, prefill);
  };
  tagUiWrapper(wrappedEditor, originalEditor);
  ui.editor = wrappedEditor;

  const originalNotify = captureUiMethod(ui, 'notify');
  const wrappedNotify: ExtensionUIContext['notify'] = (message, level) => {
    if (isActive()) notify(message, level);
    else originalNotify.call(ui, message, level);
  };
  tagUiWrapper(wrappedNotify, originalNotify);
  ui.notify = wrappedNotify;

  return () => {
    if (ui.confirm === wrappedConfirm) ui.confirm = originalConfirm;
    if (ui.select === wrappedSelect) ui.select = originalSelect;
    if (ui.input === wrappedInput) ui.input = originalInput;
    if (ui.editor === wrappedEditor) ui.editor = originalEditor;
    if (ui.notify === wrappedNotify) ui.notify = originalNotify;
  };
}

interface NotificationPluginConfig {
  readonly generation: string;
  readonly pi: ExtensionAPI;
  readonly options: NotificationExtensionOptions;
}

export function createNotificationRuntime({
  generation,
  pi,
  options,
}: NotificationPluginConfig): PiPluginContributions<NotificationExtensionOptions> {
  let activeContext: ExtensionContext | undefined;
  const router = createDoomNotificationRouter({ generation, pi, context: () => activeContext });

  const titles = options.titleController ?? createWorkerTitleController();
  const wrappedUis = new Map<ExtensionUIContext, () => void>();
  let active = true;
  let agentRunning = false;
  let askUserBlocked = false;
  let firstPrompt: string | undefined;
  let surface: TitleSurface | undefined;

  const idleTitle = (cwd: string): string =>
    shellTabTitle({ cwd, sessionName: pi.getSessionName(), prompt: firstPrompt });
  const titleSurface = (context: ExtensionContext): TitleSurface | undefined => {
    if (!active || !supportsShellTitle(context)) return undefined;
    surface = { cwd: context.cwd, write: (title) => context.ui.setTitle(title) };
    return surface;
  };
  const notifyAttention = (body: string): void => {
    if (active) void router.request(attentionNotification(body));
  };

  const stop = (): void => {
    active = false;
    agentRunning = false;
    askUserBlocked = false;
    for (const restore of wrappedUis.values()) restore();
    wrappedUis.clear();
    if (surface) titles.dispose(idleTitle(surface.cwd), surface.write);
    surface = undefined;
    activeContext = undefined;
  };
  return {
    services: [
      (cordis: Context) => {
        cordis.provide(DOOM_NOTIFICATION_SERVICE, router);
        cordis.inject([DOOM_CORDIS_SESSION_SERVICE], (sessionContext) => {
          const session = sessionContext.get(DOOM_CORDIS_SESSION_SERVICE) as DoomCordisSessionService;
          const context = session.context;
          activeContext = context;
          return () => {
            if (activeContext === context) activeContext = undefined;
          };
        });
        cordis.effect(() =>
          cordis.on(DOOM_ASK_USER_PROMPT_EVENT, (prompt) => {
            notifyAttention(askUserPromptBody(prompt.questions));
          }),
        );
        cordis.effect(() =>
          cordis.on(DOOM_ASK_USER_BLOCKED_EVENT, (payload) => {
            askUserBlocked = payload.active;
          }),
        );
      },
    ],
    onStop: stop,
    onDispose: stop,
    events: {
      [INPUT_EVENT]: (event, context) => {
        if (!active || firstPrompt || event.source === EXTENSION_INPUT_SOURCE) return;
        activeContext = context;
        firstPrompt = promptTitle(event.text);
        const target = firstPrompt ? titleSurface(context) : undefined;
        if (target) titles.set(idleTitle(target.cwd), target.write);
      },
      [SESSION_START_EVENT]: (_event, context) => {
        if (!active || wrappedUis.has(context.ui)) return;
        activeContext = context;
        wrappedUis.set(
          context.ui,
          wrapUiNotifications(
            context.ui,
            () => active,
            () => active && warrantsAttentionNotification({ agentRunning, askUserBlocked }),
            notifyAttention,
            (body, level) => void router.request({ body, ...(level ? { level } : {}) }),
          ),
        );
      },
      [AGENT_START_EVENT]: (_event, context) => {
        if (!active) return;
        activeContext = context;
        agentRunning = true;
        const target = titleSurface(context);
        if (target) titles.start(idleTitle(target.cwd), target.write);
      },
      [AGENT_SETTLED_EVENT]: async (_event, context) => {
        if (!active) return;
        activeContext = context;
        agentRunning = false;
        askUserBlocked = false;
        const target = titleSurface(context);
        if (target) titles.stop(idleTitle(target.cwd), target.write);
        if (!warrantsSettledNotification(context.hasPendingMessages())) return;
        await router.request(settledNotification({ cwd: context.cwd, sessionName: pi.getSessionName() }));
      },
    },
  };
}
