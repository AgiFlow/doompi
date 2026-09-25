import type { DoomMcpWidgetProps } from '@agimon-ai/doompi-core/web';
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { Component, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

interface View {
  readonly widget?: string;
  readonly props: DoomMcpWidgetProps;
  readonly failure?: string;
}

class WidgetBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <p role="status">The tool widget could not be rendered.</p> : this.props.children;
  }
}

/** The root only dispatches. Tool-specific presentation belongs to the contributing package. */
export function McpApp({
  widgets,
  view,
}: {
  widgets: Readonly<Record<string, ComponentType<DoomMcpWidgetProps>>>;
  view: View;
}) {
  const Widget = view.widget !== undefined && Object.hasOwn(widgets, view.widget) ? widgets[view.widget] : undefined;
  if (view.failure) return <p role="status">{view.failure}</p>;
  if (Widget === undefined)
    return (
      <p role="status">
        {view.widget === undefined ? 'Waiting for tool information...' : 'No widget is available for this tool.'}
      </p>
    );
  return (
    <WidgetBoundary key={view.widget}>
      <Widget {...view.props} />
    </WidgetBoundary>
  );
}

/** Mounts one independently sandboxed invocation of the sync-generated widget registry. */
export async function mountMcpApp(widgets: Readonly<Record<string, ComponentType<DoomMcpWidgetProps>>>): Promise<void> {
  const element = document.getElementById('root');
  if (element === null) throw new Error('Missing MCP app root');
  const root = createRoot(element);
  const app = new App({ name: 'doompi-tools', version: '1.0.0' }, {}, { autoResize: true });
  let disposed = false;
  let terminal = false;
  let connected = false;
  let appVisible = false;
  let view: View = { props: { toolName: '', args: {}, result: null, phase: 'connecting' } };

  const render = (): void => {
    if (!disposed) root.render(<McpApp widgets={widgets} view={view} />);
  };
  const fail = (message: string): void => {
    terminal = true;
    view = { ...view, failure: message };
    render();
  };
  const identify = (name: unknown, widget: unknown): boolean => {
    if (typeof name === 'string' && name.length > 0) {
      if (view.props.toolName && view.props.toolName !== name) {
        fail('The tool changed. Reopen this widget from the conversation.');
        return false;
      }
      view = { ...view, props: { ...view.props, toolName: name } };
    }
    if (typeof widget === 'string') {
      if (view.widget !== undefined && view.widget !== widget) {
        fail('The widget changed. Refresh the MCP connection.');
        return false;
      }
      view = { ...view, widget };
    }
    return true;
  };
  const updateRefresh = (): void => {
    const name = view.props.toolName;
    const enabled = connected && appVisible && !!app.getHostCapabilities()?.serverTools && name.length > 0;
    view = {
      ...view,
      props: {
        ...view.props,
        refresh: enabled
          ? async () => {
              if (disposed || name !== view.props.toolName || !appVisible)
                throw new Error('This widget is no longer active.');
              return app.callServerTool({ name, arguments: { ...view.props.args } });
            }
          : undefined,
      },
    };
  };
  const applyContext = (context: McpUiHostContext | undefined): void => {
    if (disposed || context === undefined) return;
    if (context.theme) {
      applyDocumentTheme(context.theme);
      document.documentElement.classList.toggle('dark', context.theme === 'dark');
      document.documentElement.dataset.theme = context.theme;
    }
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
    const tool = context.toolInfo?.tool;
    if (tool) {
      if (!identify(tool.name, tool._meta?.['doompi/widget'])) return;
      const ui = tool._meta?.ui as { visibility?: unknown } | undefined;
      appVisible = Array.isArray(ui?.visibility) && ui.visibility.includes('app');
    }
    updateRefresh();
    render();
  };

  app.ontoolinputpartial = ({ arguments: args }) => {
    if (disposed || terminal) return;
    view = { ...view, props: { ...view.props, args: args ?? {}, phase: 'preparing' } };
    render();
  };
  app.ontoolinput = ({ arguments: args }) => {
    if (disposed || terminal) return;
    view = { ...view, props: { ...view.props, args: args ?? {}, phase: 'running' } };
    render();
  };
  app.ontoolresult = (result) => {
    if (disposed || terminal) return;
    if (!identify(result._meta?.['doompi/toolName'], result._meta?.['doompi/widget'])) return;
    terminal = true;
    view = { ...view, props: { ...view.props, result, phase: 'result' } };
    updateRefresh();
    render();
  };
  app.ontoolcancelled = () => {
    if (disposed || terminal) return;
    terminal = true;
    view = { ...view, props: { ...view.props, phase: 'cancelled', result: null } };
    render();
  };
  app.onhostcontextchanged = applyContext;

  const dispose = (): void => {
    if (disposed) return;
    view = { ...view, failure: 'Tool view closed.' };
    render();
    disposed = true;
    window.removeEventListener('pagehide', dispose);
    setTimeout(() => {
      void app.close().catch(() => {});
    }, 0);
  };

  app.onteardown = () => {
    dispose();
    return {};
  };
  window.addEventListener('pagehide', dispose, { once: true });
  render();

  try {
    await app.connect();
    if (disposed) return;
    connected = true;
    applyContext(app.getHostContext());
  } catch {
    if (!disposed) fail('Could not connect to the app host. Reopen this widget in an MCP Apps-compatible client.');
  }
}
