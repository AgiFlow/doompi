import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface SessionHostHarness {
  calls: { name: string; arguments?: Record<string, unknown> }[];
  send(result: CallToolResult): Promise<void>;
  respond(result: CallToolResult): void;
  theme(value: 'light' | 'dark'): void;
  teardown(): Promise<void>;
}

declare global {
  interface Window {
    startSessionHost(html: string, tools: boolean): Promise<void>;
    sessionHost: SessionHostHarness;
  }
}

window.startSessionHost = async (html, tools) => {
  const iframe = document.createElement('iframe');
  iframe.id = 'session-app';
  iframe.title = 'Doompi session';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.width = '100%';
  iframe.style.height = '460px';
  iframe.style.border = '0';
  document.body.append(iframe);
  const bridge = new AppBridge(null, { name: 'doompi-test-host', version: '1' }, tools ? { serverTools: {} } : {}, {
    hostContext: { theme: 'light', displayMode: 'inline' },
  });
  const calls: SessionHostHarness['calls'] = [];
  let next: CallToolResult = { content: [], isError: true };
  bridge.oncalltool = async (params) => {
    calls.push({ name: params.name, arguments: params.arguments });
    if (params.name !== 'show_session') throw new Error('Unexpected widget tool');
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
  window.sessionHost = {
    calls,
    send: (result) => bridge.sendToolResult(result),
    respond: (result) => {
      next = result;
    },
    theme: (theme) => bridge.setHostContext({ theme, displayMode: 'inline' }),
    async teardown() {
      await bridge.teardownResource({});
      await bridge.close();
    },
  };
};
