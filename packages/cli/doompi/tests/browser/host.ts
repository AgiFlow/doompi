import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface WidgetHost {
  calls: { name: string; arguments?: Record<string, unknown> }[];
  send(result: CallToolResult): Promise<void>;
  respond(result: CallToolResult): void;
  input(args: Record<string, unknown>, partial?: boolean): Promise<void>;
  cancel(): Promise<void>;
  theme(value: 'light' | 'dark'): void;
  teardown(): Promise<void>;
}

declare global {
  interface Window {
    startWidgetHost(
      html: string,
      toolName?: string,
      widget?: string,
      appVisible?: boolean,
      serverTools?: boolean,
    ): Promise<void>;
    widgetHost: WidgetHost;
  }
}

window.startWidgetHost = async (html, toolName, widget, appVisible = false, serverTools = true) => {
  const iframe = document.createElement('iframe');
  iframe.id = 'tool-widget';
  iframe.title = 'Doompi tool widget';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.width = '100%';
  iframe.style.height = '460px';
  iframe.style.border = '0';
  document.body.append(iframe);
  const bridge = new AppBridge(
    null,
    { name: 'doompi-test-host', version: '1' },
    serverTools ? { serverTools: {} } : {},
    {
      hostContext: {
        theme: 'light',
        displayMode: 'inline',
        ...(toolName === undefined
          ? {}
          : {
              toolInfo: {
                id: 'test-call',
                tool: {
                  name: toolName,
                  inputSchema: { type: 'object' },
                  _meta: { 'doompi/widget': widget, ui: { visibility: appVisible ? ['model', 'app'] : ['model'] } },
                },
              },
            }),
      },
    },
  );
  const calls: WidgetHost['calls'] = [];
  let next: CallToolResult = { content: [], isError: true };
  bridge.oncalltool = async (params) => {
    calls.push({ name: params.name, arguments: params.arguments });
    if (!appVisible || params.name !== toolName) throw new Error('Unexpected widget tool call');
    return next;
  };
  bridge.onsizechange = ({ height }) => {
    if (height) iframe.style.height = `${height}px`;
  };
  const ready = new Promise<void>((resolve, reject) => {
    bridge.oninitialized = () => {
      void bridge.sendToolInput({ arguments: {} }).then(resolve, reject);
    };
  });
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  iframe.srcdoc = html;
  await ready;
  window.widgetHost = {
    calls,
    send: (result) => bridge.sendToolResult(result),
    respond: (result) => {
      next = result;
    },
    input: (args, partial = false) =>
      partial ? bridge.sendToolInputPartial({ arguments: args }) : bridge.sendToolInput({ arguments: args }),
    cancel: () => bridge.sendToolCancelled({ reason: 'Cancelled by user' }),
    theme: (theme) => bridge.setHostContext({ theme, displayMode: 'inline' }),
    async teardown() {
      await bridge.teardownResource({});
      await bridge.close();
    },
  };
};
