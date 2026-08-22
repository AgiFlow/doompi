import {
  DOOM_ASK_USER_BLOCKED_EVENT,
  DOOM_ASK_USER_PROMPT_EVENT,
} from '@agimon-ai/doompi-extension-contracts/ask-user';
import { SUBAGENT_CHILD_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import {
  askUserPromptBody,
  supportsShellTitle,
  warrantsAttentionNotification,
  warrantsSettledNotification,
} from '../../services/notificationPolicy.ts';
import {
  attentionNotification,
  promptTitle,
  settledNotification,
  shellTabTitle,
} from '../../services/notificationText.ts';
import type { ShellTitleController, WriteTitle } from '../../types/notifications.ts';
import { createWorkerTitleController } from '../shellTitleController.ts';
import { sendSystemNotification } from '../systemNotification.ts';

const AGENT_SETTLED_EVENT = 'agent_settled';
const AGENT_START_EVENT = 'agent_start';
const EXTENSION_INPUT_SOURCE = 'extension';
const INPUT_EVENT = 'input';
const PACKAGE_SOURCE = '@agimon-ai/doompi-notification';
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

type AttentionDialogMethod = 'confirm' | 'editor' | 'input' | 'select';

/** Capture a host method whose original identity must be restored after reload. */
function captureUiMethod<Method extends AttentionDialogMethod>(
  ui: ExtensionUIContext,
  method: Method,
): ExtensionUIContext[Method] {
  return ui[method];
}

/**
 * Announces every dialog the agent opens on its own initiative.
 *
 * Pi has no event for "a dialog is showing", so the only way to catch one is to
 * wrap the UI context the session hands out. Each wrapper delegates to the
 * original, so nothing about the dialog itself changes.
 */
function wrapAttentionDialogs(
  ui: ExtensionUIContext,
  shouldNotify: () => boolean,
  notify: (body: string) => void,
): () => void {
  const originalConfirm = captureUiMethod(ui, 'confirm');
  const wrappedConfirm: ExtensionUIContext['confirm'] = (title, message, options) => {
    if (shouldNotify()) notify(`${title}: ${message}`);
    return originalConfirm.call(ui, title, message, options);
  };
  ui.confirm = wrappedConfirm;

  const originalSelect = captureUiMethod(ui, 'select');
  const wrappedSelect: ExtensionUIContext['select'] = (title, options, dialogOptions) => {
    if (shouldNotify()) notify(title);
    return originalSelect.call(ui, title, options, dialogOptions);
  };
  ui.select = wrappedSelect;

  const originalInput = captureUiMethod(ui, 'input');
  const wrappedInput: ExtensionUIContext['input'] = (title, placeholder, options) => {
    if (shouldNotify()) notify(title);
    return originalInput.call(ui, title, placeholder, options);
  };
  ui.input = wrappedInput;

  const originalEditor = captureUiMethod(ui, 'editor');
  const wrappedEditor: ExtensionUIContext['editor'] = (title, prefill) => {
    if (shouldNotify()) notify(title);
    return originalEditor.call(ui, title, prefill);
  };
  ui.editor = wrappedEditor;

  return () => {
    if (ui.confirm === wrappedConfirm) ui.confirm = originalConfirm;
    if (ui.select === wrappedSelect) ui.select = originalSelect;
    if (ui.input === wrappedInput) ui.input = originalInput;
    if (ui.editor === wrappedEditor) ui.editor = originalEditor;
  };
}

interface NotificationPluginConfig {
  readonly pi: ExtensionAPI;
  readonly options: NotificationExtensionOptions;
}

function notificationPlugin(cordis: Context, { pi, options }: NotificationPluginConfig): void {
  cordis.effect(function* () {
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
      if (active) void sendSystemNotification(pi, attentionNotification(body));
    };

    yield cordis.on(DOOM_ASK_USER_PROMPT_EVENT, (prompt) => {
      notifyAttention(askUserPromptBody(prompt.questions));
    });
    yield cordis.on(DOOM_ASK_USER_BLOCKED_EVENT, (payload) => {
      askUserBlocked = payload.active;
    });

    yield () => {
      if (surface) titles.dispose(idleTitle(surface.cwd), surface.write);
      surface = undefined;
    };
    yield () => {
      for (const restore of wrappedUis.values()) restore();
      wrappedUis.clear();
    };
    yield () => {
      active = false;
      agentRunning = false;
      askUserBlocked = false;
    };

    pi.on(INPUT_EVENT, (event, context) => {
      if (!active || firstPrompt || event.source === EXTENSION_INPUT_SOURCE) return;
      firstPrompt = promptTitle(event.text);
      const target = firstPrompt ? titleSurface(context) : undefined;
      if (target) titles.set(idleTitle(target.cwd), target.write);
    });

    pi.on(SESSION_START_EVENT, (_event, context) => {
      if (!active || wrappedUis.has(context.ui)) return;
      wrappedUis.set(
        context.ui,
        wrapAttentionDialogs(
          context.ui,
          () => active && warrantsAttentionNotification({ agentRunning, askUserBlocked }),
          notifyAttention,
        ),
      );
    });

    pi.on(AGENT_START_EVENT, (_event, context) => {
      if (!active) return;
      agentRunning = true;
      const target = titleSurface(context);
      if (target) titles.start(idleTitle(target.cwd), target.write);
    });

    pi.on(AGENT_SETTLED_EVENT, async (_event, context) => {
      if (!active) return;
      agentRunning = false;
      askUserBlocked = false;
      const target = titleSurface(context);
      if (target) titles.stop(idleTitle(target.cwd), target.write);
      if (!warrantsSettledNotification(context.hasPendingMessages())) return;
      await sendSystemNotification(pi, settledNotification({ cwd: context.cwd, sessionName: pi.getSessionName() }));
    });
  }, PACKAGE_SOURCE);
}

/** The package's single standard Pi factory. */
export async function notificationExtension(
  pi: ExtensionAPI,
  options: NotificationExtensionOptions = {},
): Promise<void> {
  if ((options.environment ?? process.env)[SUBAGENT_CHILD_ENV]) return;

  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE, {
    environment: options.environment ?? process.env,
  });
  const fiber = connection.root.plugin(notificationPlugin, { pi, options });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

export default notificationExtension;
