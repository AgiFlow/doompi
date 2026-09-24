import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';

const inputLabels: Record<string, string> = {
  path: 'Path',
  pattern: 'Pattern',
  offset: 'Start line',
  limit: 'Limit',
  action: 'Action',
  name: 'Name',
  query: 'Search',
  server: 'Server',
  tool: 'Tool',
};
const previewLimit = 8000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function bounded(value: string, limit = 500): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

async function mountActivityApp(): Promise<void> {
  const heading = document.querySelector<HTMLElement>('#heading')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const input = document.querySelector<HTMLElement>('#input')!;
  const output = document.querySelector<HTMLDetailsElement>('#output')!;
  const preview = document.querySelector<HTMLElement>('#preview')!;
  const note = document.querySelector<HTMLElement>('#note')!;
  const duration = document.querySelector<HTMLElement>('#duration')!;
  const app = new App({ name: 'doompi-tool-activity', version: '1.0.0' }, {}, { autoResize: true });
  let disposed = false;
  let terminal = false;
  let receivedInput = false;

  const showStatus = (text: string, state: string): void => {
    status.textContent = text;
    status.dataset.state = state;
  };
  const renderInput = (value: unknown): void => {
    const args = record(value);
    if (!args) return;
    input.replaceChildren();
    for (const [key, label] of Object.entries(inputLabels)) {
      const item = args[key];
      if (typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item)))
        continue;
      const row = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = bounded(String(item));
      row.append(term, description);
      input.append(row);
    }
    input.hidden = input.childElementCount === 0;
  };
  const applyContext = (context: McpUiHostContext | undefined): void => {
    if (disposed || !context) return;
    if (context.theme) applyDocumentTheme(context.theme);
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
    if (!terminal && context.toolInfo?.tool) {
      heading.textContent = bounded(context.toolInfo.tool.title ?? context.toolInfo.tool.name, 160);
    }
  };
  const receiveInput: NonNullable<App['ontoolinput']> = (params) => {
    if (disposed || terminal) return;
    receivedInput = true;
    renderInput(params.arguments);
    showStatus('Running tool...', 'running');
  };
  app.ontoolinput = receiveInput;
  app.ontoolinputpartial = (params) => {
    if (disposed || terminal) return;
    receivedInput = true;
    renderInput(params.arguments);
    showStatus('Preparing tool...', 'pending');
  };
  app.ontoolresult = (result) => {
    if (disposed || terminal) return;
    terminal = true;
    const activity = record(result._meta?.['doompi/toolActivity']);
    if (activity) {
      const title = typeof activity.title === 'string' ? activity.title : activity.tool;
      if (typeof title === 'string') heading.textContent = bounded(title, 160);
      renderInput(activity.input);
      if (typeof activity.durationMs === 'number' && Number.isFinite(activity.durationMs) && activity.durationMs >= 0) {
        duration.textContent = `${(activity.durationMs / 1000).toFixed(1)} s`;
      }
    }
    // Keep native text useful and bounded. Never inject HTML, fetch resources, or embed result URLs.
    let text = '';
    let truncated = false;
    let nonText = 0;
    for (const item of result.content ?? []) {
      if (item.type !== 'text') {
        nonText += 1;
        continue;
      }
      const remaining = previewLimit - text.length;
      const part = `${text ? '\n' : ''}${item.text}`;
      if (part.length > remaining) truncated = true;
      text += part.slice(0, remaining);
    }
    if (!text && result.structuredContent) {
      const serialized = JSON.stringify(result.structuredContent, null, 2);
      truncated = serialized.length > previewLimit;
      text = serialized.slice(0, previewLimit);
    }
    preview.textContent = text || (nonText ? 'Non-text result returned to the agent.' : 'No text output.');
    note.textContent = [
      truncated ? 'Preview truncated. Full output remains in the tool result.' : '',
      nonText ? `${nonText} non-text content item${nonText === 1 ? '' : 's'} returned to the agent.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    note.hidden = !note.textContent;
    output.hidden = false;
    showStatus(result.isError ? 'Tool failed' : 'Result received', result.isError ? 'error' : 'success');
  };
  app.ontoolcancelled = () => {
    if (disposed || terminal) return;
    terminal = true;
    showStatus('Tool cancelled', 'cancelled');
  };
  app.onhostcontextchanged = applyContext;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('pagehide', dispose);
    showStatus('Activity view closed.', 'closed');
    setTimeout(() => {
      void app.close().catch(() => {});
    }, 0);
  };
  app.onteardown = () => {
    dispose();
    return {};
  };
  window.addEventListener('pagehide', dispose, { once: true });
  try {
    await app.connect();
    if (disposed) return;
    applyContext(app.getHostContext());
    if (!terminal && !receivedInput) showStatus('Waiting for tool input...', 'pending');
  } catch {
    if (!disposed && !terminal) {
      terminal = true;
      showStatus('Could not connect to the app host. Reopen this widget in an MCP Apps-compatible client.', 'error');
    }
  }
}

void mountActivityApp();
