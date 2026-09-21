import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';

import type { SessionView } from '../../../../../types/sessionView';

function isSessionView(value: unknown): value is SessionView {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.sessionId === 'string' &&
    data.sessionId.length > 0 &&
    typeof data.repositoryName === 'string' &&
    typeof data.majorMode === 'string' &&
    Number.isSafeInteger(data.revision) &&
    (data.revision as number) >= 0 &&
    (data.profile === null || typeof data.profile === 'string') &&
    ['domains', 'layers', 'minorModes'].every(
      (key) => Array.isArray(data[key]) && data[key].every((item: unknown) => typeof item === 'string'),
    )
  );
}

async function mountSessionApp(): Promise<void> {
  const refresh = document.querySelector<HTMLButtonElement>('#refresh')!;
  const summary = document.querySelector<HTMLElement>('#summary')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const app = new App({ name: 'doompi-session', version: '1.0.0' }, {}, { autoResize: true });
  let disposed = false;
  let connected = false;
  let receivedResult = false;
  let refreshing = false;
  let sessionId: string | undefined;

  const updateButton = (): void => {
    refresh.disabled =
      disposed || !connected || !receivedResult || refreshing || !app.getHostCapabilities()?.serverTools;
  };
  const showError = (message: string): void => {
    if (disposed) return;
    summary.hidden = true;
    status.dataset.error = 'true';
    status.textContent = message;
  };
  const render: NonNullable<App['ontoolresult']> = (result) => {
    if (disposed) return;
    receivedResult = true;
    updateButton();
    if (result.isError) {
      showError('Session could not be loaded. Check the Doompi connection and session setup, then refresh.');
      return;
    }
    const view = result.structuredContent;
    if (!isSessionView(view)) {
      showError('The host returned an invalid session summary. Refresh the connection before trying again.');
      return;
    }
    if (sessionId !== undefined && sessionId !== view.sessionId) {
      showError('The session changed. Reopen the session widget from this conversation.');
      return;
    }
    sessionId = view.sessionId;
    const fields = [
      'sessionId',
      'revision',
      'repositoryName',
      'profile',
      'majorMode',
      'domains',
      'layers',
      'minorModes',
    ] as const;
    for (const key of fields) {
      const value = view[key];
      const element = document.getElementById(key);
      if (element === null || !summary.contains(element)) continue;
      element.textContent = Array.isArray(value) ? value.join(', ') || 'None' : String(value ?? 'Default');
    }
    summary.hidden = false;
    status.dataset.error = 'false';
    status.textContent = 'Read-only session summary.';
  };
  const applyContext = (context: McpUiHostContext | undefined): void => {
    if (disposed || context === undefined) return;
    if (context.theme) applyDocumentTheme(context.theme);
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  };
  const refreshSession = async (): Promise<void> => {
    if (refresh.disabled) return;
    refreshing = true;
    updateButton();
    status.dataset.error = 'false';
    status.textContent = 'Refreshing session...';
    try {
      render(await app.callServerTool({ name: 'show_session', arguments: {} }));
    } catch {
      showError('Refresh failed. Check the Doompi connection, then try again.');
    } finally {
      refreshing = false;
      updateButton();
    }
  };
  const onRefresh = (): void => {
    void refreshSession();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    refresh.removeEventListener('click', onRefresh);
    window.removeEventListener('pagehide', dispose);
    updateButton();
    summary.hidden = true;
    status.textContent = 'Session view closed.';
    // Let the SDK send its teardown response before closing the bridge.
    setTimeout(() => {
      void app.close().catch(() => {});
    }, 0);
  };

  app.ontoolresult = render;
  app.onhostcontextchanged = applyContext;
  app.ontoolcancelled = () => {
    receivedResult = true;
    showError('Session request was cancelled.');
    updateButton();
  };
  app.onteardown = () => {
    dispose();
    return {};
  };
  refresh.addEventListener('click', onRefresh);
  window.addEventListener('pagehide', dispose, { once: true });
  try {
    await app.connect();
    if (disposed) return;
    connected = true;
    applyContext(app.getHostContext());
    if (!receivedResult) status.textContent = 'Waiting for session data...';
    updateButton();
  } catch {
    showError('Could not connect to the app host. Reopen this widget in an MCP Apps-compatible client.');
  }
}

void mountSessionApp();
