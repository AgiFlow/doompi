import type {
  AuthMethodType,
  LoginEvent,
  LoginFlowSnapshot,
  LoginFlowStatus,
  LoginInteraction,
  LoginPrompt,
  LoginPromptView,
} from '../types/auth.ts';

/** The message Pi's own login dialog uses; a provider flow may match on it. */
const CANCELLED_MESSAGE = 'Login cancelled';
const SUPERSEDED_MESSAGE = 'Superseded by a newer prompt';

/**
 * Option ids Pi's providers use for their redirect-free login.
 *
 * The spelling is not consistent across providers: openai-codex offers
 * `device_code` and radius offers `device-code`, so both are matched rather
 * than assuming one canonical form.
 */
const DEVICE_CODE_OPTION_IDS: ReadonlySet<string> = new Set(['device_code', 'device-code']);

interface PendingPrompt {
  view: LoginPromptView;
  resolve(value: string): void;
  reject(error: Error): void;
  detach(): void;
}

export interface LoginFlowInput {
  id: string;
  providerId: string;
  providerName: string;
  type: AuthMethodType;
  /**
   * The login was started from the tunnel, so the browser is on another
   * machine and a loopback redirect cannot reach this host.
   */
  remote?: boolean;
}

/**
 * The redirect-free option a remote login should take, when the provider
 * offers one.
 *
 * Pi asks browser-or-device-code as an ordinary select. A remote browser
 * cannot receive a loopback redirect, so answering it for the user turns a
 * dead end into the one method that works, rather than showing a choice whose
 * default is broken.
 */
function deviceCodeOption(prompt: LoginPrompt): string | undefined {
  if (prompt.type !== 'select') return undefined;
  return prompt.options.find((option) => DEVICE_CODE_OPTION_IDS.has(option.id))?.id;
}

/**
 * One login in progress, seen from both sides: the provider's flow talks to
 * it through `interaction`, the page through snapshots and answers.
 */
export interface LoginFlow {
  readonly id: string;
  readonly providerId: string;
  /** Hand this to the runtime's login; prompts and events route through the flow. */
  readonly interaction: LoginInteraction;
  snapshot(): LoginFlowSnapshot;
  /** Answers the pending prompt; false when the flow is not waiting on that prompt. */
  answer(promptId: string, value: string): boolean;
  /** Aborts the provider's flow; a settled flow is left as it ended. */
  cancel(): void;
  /** Records how the runtime's login ended; a cancelled flow stays cancelled. */
  settle(outcome: { ok: true } | { ok: false; error: string }): void;
}

function promptView(id: string, prompt: LoginPrompt): LoginPromptView {
  const view: LoginPromptView = { id, type: prompt.type, message: prompt.message };
  if (prompt.type === 'select') view.options = prompt.options.map((option) => ({ ...option }));
  else if (prompt.placeholder !== undefined) view.placeholder = prompt.placeholder;
  return view;
}

/**
 * The state machine between a provider login and a browser that can only
 * poll and post.
 *
 * A provider asks one question at a time and may withdraw it (a manual-code
 * prompt raced against a callback server aborts when the callback wins), so
 * the flow holds at most one pending prompt, rejects it when its signal
 * fires, and supersedes it if the provider asks again.
 */
export function createLoginFlow(input: LoginFlowInput): LoginFlow {
  const controller = new AbortController();
  const events: LoginEvent[] = [];
  let status: LoginFlowStatus = 'running';
  let error: string | undefined;
  let pending: PendingPrompt | undefined;
  let promptSeq = 0;

  const failPending = (reason: Error): void => {
    const current = pending;
    if (!current) return;
    pending = undefined;
    current.detach();
    current.reject(reason);
  };

  const interaction: LoginInteraction = {
    signal: controller.signal,
    prompt(prompt) {
      if (controller.signal.aborted || prompt.signal?.aborted) return Promise.reject(new Error(CANCELLED_MESSAGE));
      failPending(new Error(SUPERSEDED_MESSAGE));
      // Answered before a view exists, so the page never renders a choice the
      // remote browser cannot complete.
      if (input.remote) {
        const deviceCode = deviceCodeOption(prompt);
        if (deviceCode !== undefined) return Promise.resolve(deviceCode);
      }
      promptSeq += 1;
      const view = promptView(String(promptSeq), prompt);
      return new Promise<string>((resolve, reject) => {
        const onAbort = (): void => failPending(new Error(CANCELLED_MESSAGE));
        prompt.signal?.addEventListener('abort', onAbort, { once: true });
        pending = {
          view,
          resolve,
          reject,
          detach: () => prompt.signal?.removeEventListener('abort', onAbort),
        };
      });
    },
    notify(event) {
      events.push(event);
    },
  };

  return {
    id: input.id,
    providerId: input.providerId,
    interaction,
    snapshot() {
      const snapshot: LoginFlowSnapshot = {
        id: input.id,
        providerId: input.providerId,
        providerName: input.providerName,
        type: input.type,
        status,
        events: [...events],
      };
      if (pending) snapshot.prompt = pending.view;
      if (input.remote) snapshot.remote = true;
      if (error !== undefined) snapshot.error = error;
      return snapshot;
    },
    answer(promptId, value) {
      const current = pending;
      if (!current || current.view.id !== promptId) return false;
      pending = undefined;
      current.detach();
      current.resolve(value);
      return true;
    },
    cancel() {
      if (status !== 'running') return;
      status = 'cancelled';
      controller.abort();
      failPending(new Error(CANCELLED_MESSAGE));
    },
    settle(outcome) {
      if (status !== 'running') return;
      if (outcome.ok) {
        status = 'succeeded';
      } else {
        status = 'failed';
        error = outcome.error;
      }
      failPending(new Error(CANCELLED_MESSAGE));
    },
  };
}
