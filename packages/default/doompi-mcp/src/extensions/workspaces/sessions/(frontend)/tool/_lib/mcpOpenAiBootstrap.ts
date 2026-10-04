interface LegacyGlobals {
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolResponseMetadata: Record<string, unknown>;
  widgetState: unknown;
  theme: 'light' | 'dark';
  locale: string;
  displayMode: 'inline';
  maxHeight: number;
  userAgent: { device: { type: 'desktop' | 'mobile' }; capabilities: { hover: boolean; touch: boolean } };
  safeArea: { insets: { top: number; right: number; bottom: number; left: number } };
}

function bootstrap(initial: LegacyGlobals): void {
  const channel = 'doompi.openai';
  const requestTimeout = 60_000;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
  let sequence = 0;
  let globals = initial;
  const update = (patch: Partial<LegacyGlobals>): void => {
    globals = { ...globals, ...patch };
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: patch } }));
  };
  const request = (method: string, input: unknown): Promise<unknown> => {
    if (pending.size >= 32) return Promise.reject(new Error('Too many pending widget requests'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error('Widget request timed out'));
      }, requestTimeout);
      pending.set(id, { resolve, reject, timer });
      parent.postMessage({ channel, id, method, input }, '*');
    });
  };
  const api = {
    get toolInput() {
      return globals.toolInput;
    },
    get toolOutput() {
      return globals.toolOutput;
    },
    get toolResponseMetadata() {
      return globals.toolResponseMetadata;
    },
    get widgetState() {
      return globals.widgetState;
    },
    get theme() {
      return globals.theme;
    },
    get locale() {
      return globals.locale;
    },
    get displayMode() {
      return globals.displayMode;
    },
    get maxHeight() {
      return globals.maxHeight;
    },
    get safeArea() {
      return globals.safeArea;
    },
    get userAgent() {
      return globals.userAgent;
    },
    callTool: (name: string, args: Record<string, unknown> = {}) => request('callTool', { name, arguments: args }),
    setWidgetState: (state: unknown) => {
      // Immediate local state, with await-compatible durable persistence.
      update({ widgetState: state });
      return request('setState', { state });
    },
    sendFollowUpMessage: (input: { prompt: string }) => request('followUp', input),
    requestDisplayMode: () => Promise.resolve({ mode: 'inline' }),
    openExternal: (input: { href: string }) => request('openLink', { url: input.href }),
    requestClose: () => request('close', {}),
    notifyIntrinsicHeight: (height: number) => request('height', { height }),
  };
  Object.defineProperty(window, 'openai', { value: Object.freeze(api), configurable: false, writable: false });
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== parent) return;
    const message = event.data as {
      channel?: string;
      id?: number;
      error?: string;
      result?: unknown;
      globals?: Partial<LegacyGlobals>;
    };
    if (message?.channel !== channel) return;
    if (message.globals !== undefined) update(message.globals);
    if (message.id === undefined) return;
    const callback = pending.get(message.id);
    if (callback === undefined) return;
    pending.delete(message.id);
    clearTimeout(callback.timer);
    if (typeof message.error === 'string') callback.reject(new Error(message.error));
    else callback.resolve(message.result);
  });
  parent.postMessage({ channel, method: 'initialized', input: {} }, '*');
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      update(globals);
      const observer = new ResizeObserver(() => {
        const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        parent.postMessage({ channel, method: 'height', input: { height } }, '*');
      });
      observer.observe(document.body);
      window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    },
    { once: true },
  );
}

export function mcpOpenAiScript(globals: LegacyGlobals): string {
  const encoded = JSON.stringify(globals)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `<script>(${bootstrap.toString()})(${encoded})</script>`;
}
