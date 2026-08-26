import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { createPiTestHost } from '../../src/adapters/testing/piHost.ts';

/** A tool shaped the way a real one is, so the harness is exercised through Pi's own type. */
function echoTool(name: string, execute: (params: { text: string }) => unknown) {
  return {
    name,
    label: name,
    description: `Echoes for ${name}.`,
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id: string, params: { text: string }) => ({
      content: [{ type: 'text' as const, text: String(execute(params)) }],
      details: undefined,
    }),
  };
}

describe('the Pi test host', () => {
  it('records what an extension registered, in the order it registered it', () => {
    const host = createPiTestHost();

    host.pi.registerTool(echoTool('first', (params) => params.text));
    host.pi.registerTool(echoTool('second', (params) => params.text));
    host.pi.registerCommand('demo', { description: 'Demo', handler: async () => undefined });

    expect(host.tools.map(({ name }) => name)).toEqual(['first', 'second']);
    expect(host.activeTools()).toEqual(['first', 'second']);
    expect(host.command('demo')?.options.description).toBe('Demo');
    expect(host.tool('missing')).toBeUndefined();
  });

  it('offers the tools the extension last set active, not the ones it registered', () => {
    const host = createPiTestHost();
    host.pi.registerTool(echoTool('kept', () => 'kept'));
    host.pi.registerTool(echoTool('dropped', () => 'dropped'));

    host.pi.setActiveTools(['kept']);

    // Registration and activation are separate in Pi, and a mode that hands
    // tools back relies on the difference.
    expect(host.activeTools()).toEqual(['kept']);
    expect(host.tools).toHaveLength(2);
  });

  it('runs lifecycle handlers in order and hands each the same context', async () => {
    const host = createPiTestHost();
    const seen: string[] = [];
    host.pi.on('session_start', (event, context) => {
      seen.push(`first:${event.reason}:${context.sessionManager.getSessionId()}`);
    });
    host.pi.on('session_start', (event) => {
      seen.push(`second:${event.type}`);
      return undefined;
    });

    const answered = await host.emit('session_start', { reason: 'startup' }, host.context({ sessionId: 's1' }));

    expect(seen).toEqual(['first:startup:s1', 'second:session_start']);
    expect(answered).toHaveLength(2);
  });

  it('does not deliver an emission to a handler registered during it', async () => {
    const host = createPiTestHost();
    const late: string[] = [];
    host.pi.on('session_shutdown', () => {
      host.pi.on('session_shutdown', () => {
        late.push('late');
      });
    });

    await host.emit('session_shutdown');

    // Pi snapshots its handler list per emission; a harness that did not would
    // make a re-registering extension look like an infinite loop.
    expect(late).toEqual([]);
    expect(host.handlers('session_shutdown')).toHaveLength(2);
  });

  it('calls a registered tool the way the runner does and refuses an unknown one', async () => {
    const host = createPiTestHost();
    host.pi.registerTool(echoTool('shout', (params) => params.text.toUpperCase()));

    const result = await host.callTool('shout', { text: 'hi' });

    expect(result).toMatchObject({ content: [{ text: 'HI' }] });
    await expect(host.callTool('absent')).rejects.toThrow("No tool named 'absent'");
  });

  it('runs a slash command and refuses an unclaimed one', async () => {
    const host = createPiTestHost();
    const received: string[] = [];
    host.pi.registerCommand('greet', {
      handler: async (args) => {
        received.push(args);
      },
    });

    await host.runCommand('greet', 'world');

    expect(received).toEqual(['world']);
    await expect(host.runCommand('absent')).rejects.toThrow("No command named 'absent'");
  });

  it('records UI traffic against the session that produced it', async () => {
    const host = createPiTestHost();
    const first = host.context({ sessionId: 'a' });
    const second = host.context({ sessionId: 'b' });

    first.ui.notify('from a', 'warning');
    second.ui.notify('from b');
    second.ui.setStatus('doom-demo', 'ready');
    first.ui.setWidget('demo-widget', ['line']);

    expect(host.notifications).toEqual([
      { sessionId: 'a', message: 'from a', level: 'warning' },
      { sessionId: 'b', message: 'from b', level: undefined },
    ]);
    expect(host.statuses).toEqual([{ sessionId: 'b', key: 'doom-demo', text: 'ready' }]);
    expect(host.widgets).toEqual([{ sessionId: 'a', key: 'demo-widget', content: ['line'] }]);
  });

  it('dismisses every dialog by default and answers the ones a test scripts', async () => {
    const dismissing = createPiTestHost().context();
    const scripted = createPiTestHost({
      answers: { confirm: () => true, select: (_title, options) => options[1], input: () => 'typed' },
    }).context();

    // A dismissal is what a headless host gives, and the answer an extension is
    // most likely to mishandle, so it is the default.
    await expect(dismissing.ui.confirm('Title', 'Sure?')).resolves.toBe(false);
    await expect(dismissing.ui.select('Title', ['a', 'b'])).resolves.toBeUndefined();
    await expect(dismissing.ui.editor('Title')).resolves.toBeUndefined();
    await expect(scripted.ui.confirm('Title', 'Sure?')).resolves.toBe(true);
    await expect(scripted.ui.select('Title', ['a', 'b'])).resolves.toBe('b');
    await expect(scripted.ui.input('Title')).resolves.toBe('typed');
  });

  it('carries the event bus between two extensions on one runner', () => {
    const host = createPiTestHost();
    const heard: unknown[] = [];

    const unsubscribe = host.pi.events.on('doom:demo', (data) => heard.push(data));
    host.pi.events.emit('doom:demo', { value: 1 });
    unsubscribe();
    host.pi.events.emit('doom:demo', { value: 2 });

    expect(heard).toEqual([{ value: 1 }]);
  });

  it('answers exec from the script a test supplies and records the call', async () => {
    const host = createPiTestHost({
      exec: (command) => ({ code: command === 'true' ? 0 : 1, killed: false, stdout: command, stderr: '' }),
    });

    await expect(host.pi.exec('true', ['--now'])).resolves.toMatchObject({ code: 0, stdout: 'true' });
    await expect(host.pi.exec('false', [])).resolves.toMatchObject({ code: 1 });
    expect(host.execs.map(({ command, args }) => [command, args])).toEqual([
      ['true', ['--now']],
      ['false', []],
    ]);
  });

  it('records both shapes of a provider registration', () => {
    const host = createPiTestHost();

    host.pi.registerProvider('ollama', { baseUrl: 'http://localhost:11434/v1' });
    host.pi.unregisterProvider('ollama');

    expect(host.providers).toEqual([{ name: 'ollama', value: { baseUrl: 'http://localhost:11434/v1' } }]);
    expect(host.unregisteredProviders).toEqual(['ollama']);
  });

  it('reports the run mode and UI availability a headless host would', () => {
    const host = createPiTestHost({ hasUI: false, mode: 'rpc' });

    const context = host.context();

    expect(context.hasUI).toBe(false);
    expect(context.mode).toBe('rpc');
    // A per-context override wins, so one host can exercise both halves.
    expect(host.context({ hasUI: true }).hasUI).toBe(true);
  });

  it('installs one real Cordis host and disposes it', async () => {
    const host = createPiTestHost();

    const connection = await host.cordis();
    const same = await host.cordis();

    expect(connection.runtime.abiVersion).toBeGreaterThan(0);
    // Two calls share one host: an extension and its test must not end up on
    // separate roots, or a provided service is invisible to the other.
    expect(same).toBe(connection);
    await host.dispose();
  });

  it('answers every UI call an extension can make where there is no terminal', () => {
    // The point of the harness is that an extension written against a full Pi
    // host runs against it unchanged. A member that is merely absent surfaces
    // as "ui.setTitle is not a function" inside the extension, which is the
    // failure this whole surface exists to prevent.
    const { ui } = createPiTestHost().context();

    expect(() => {
      ui.setWorkingMessage('working');
      ui.setWorkingMessage();
      ui.setWorkingVisible(false);
      ui.setWorkingIndicator({ frames: ['.'] });
      ui.setHiddenThinkingLabel('thinking');
      ui.setFooter(undefined);
      ui.setHeader(undefined);
      ui.setTitle('doom');
      ui.pasteToEditor('text');
      ui.setEditorText('text');
      ui.addAutocompleteProvider(() => ({
        getSuggestions: async () => null,
        applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({
          lines,
          cursorLine,
          cursorCol,
        }),
      }));
      ui.setEditorComponent(undefined);
      ui.setToolsExpanded(true);
      ui.onTerminalInput(() => undefined)();
    }).not.toThrow();

    expect(ui.getEditorText()).toBe('');
    expect(ui.getEditorComponent()).toBeUndefined();
    expect(ui.getAllThemes()).toEqual([]);
    expect(ui.getTheme('doom')).toBeUndefined();
    expect(ui.setTheme('doom')).toMatchObject({ success: false });
    expect(ui.getToolsExpanded()).toBe(false);
  });

  it('answers the session reads an extension makes about where it is running', () => {
    const host = createPiTestHost({ cwd: '/workspace/repo' });
    host.pi.setSessionName('named');

    const { sessionManager } = host.context({ sessionId: 's9' });

    expect(sessionManager.getSessionId()).toBe('s9');
    expect(sessionManager.getCwd()).toBe('/workspace/repo');
    expect(sessionManager.getSessionName()).toBe('named');
    expect(sessionManager.getSessionFile()).toBe('/workspace/repo/s9.jsonl');
    expect(sessionManager.getSessionDir()).toBe('/workspace/repo');
    expect(sessionManager.getEntries()).toEqual([]);
    expect(sessionManager.getBranch()).toEqual([]);
    expect(sessionManager.getTree()).toEqual([]);
    expect(sessionManager.buildContextEntries()).toEqual([]);
    expect(sessionManager.getLeafId()).toBeUndefined();
    expect(sessionManager.getEntry('e1')).toBeUndefined();
  });

  it('reports the agent as idle and trusted unless a test says otherwise', () => {
    const host = createPiTestHost();

    const idle = host.context();
    const busy = host.context({ isIdle: false, isProjectTrusted: false, systemPrompt: 'be brief' });

    expect(idle.isIdle()).toBe(true);
    expect(idle.isProjectTrusted()).toBe(true);
    expect(idle.getSystemPrompt()).toBe('');
    expect(idle.hasPendingMessages()).toBe(false);
    expect(idle.getContextUsage()).toBeUndefined();
    expect(idle.signal).toBeUndefined();
    expect(() => {
      idle.abort();
      idle.compact();
      idle.shutdown();
    }).not.toThrow();
    expect(busy.isIdle()).toBe(false);
    expect(busy.isProjectTrusted()).toBe(false);
    expect(busy.getSystemPrompt()).toBe('be brief');
  });

  it('records the entries, messages, and flags an extension writes', () => {
    const host = createPiTestHost();

    host.pi.registerFlag('demo', { type: 'boolean', default: true });
    host.pi.appendEntry('doom-demo', { note: 'kept' });
    host.pi.sendMessage({ customType: 'doom-demo', content: 'shown', display: true });
    host.pi.sendUserMessage('prompt', { deliverAs: 'followUp' });
    host.pi.setLabel('e1', 'bookmark');
    host.pi.setThinkingLevel('high');

    expect(host.pi.getFlag('demo')).toBe(true);
    expect(host.pi.getFlag('absent')).toBeUndefined();
    expect(host.entries).toEqual([{ customType: 'doom-demo', data: { note: 'kept' } }]);
    expect(host.messages[0]?.message).toMatchObject({ content: 'shown' });
    expect(host.userMessages[0]).toMatchObject({ content: 'prompt', options: { deliverAs: 'followUp' } });
    expect(host.pi.getThinkingLevel()).toBe('high');
    expect(host.pi.getAllTools()).toEqual([]);
    expect(host.pi.getCommands()).toEqual([]);
  });

  it('records the renderers a package contributes to the transcript', () => {
    const host = createPiTestHost();
    const renderer = () => undefined;
    const transformer = (markdown: string): string => markdown;

    host.pi.registerMessageRenderer('doom-demo', renderer);
    host.pi.registerEntryRenderer('doom-demo-entry', renderer);
    host.pi.registerMarkdownTransformer(transformer);
    host.pi.registerShortcut('ctrl+d', { description: 'Demo', handler: () => undefined });

    expect(host.messageRenderers).toEqual([{ customType: 'doom-demo', renderer }]);
    expect(host.entryRenderers).toEqual([{ customType: 'doom-demo-entry', renderer }]);
    expect(host.markdownTransformers).toEqual([transformer]);
    expect(host.shortcuts[0]?.shortcut).toBe('ctrl+d');
  });

  it('reports no model, because none is configured on a host that reaches nothing', async () => {
    const host = createPiTestHost();

    await expect(host.pi.setModel({ id: 'demo' } as never)).resolves.toBe(false);
    expect(host.context().model).toBeUndefined();
    expect(host.context().scopedModels).toEqual([]);
  });

  it('satisfies the ExtensionAPI Pi declares, with no cast', () => {
    // The assignment is the assertion. Every other fake in the repository was
    // an `as unknown as ExtensionAPI`, which type-checks against any interface
    // Pi might grow; this one stops compiling when Pi's does.
    const api: ExtensionAPI = createPiTestHost().pi;

    expect(typeof api.registerTool).toBe('function');
  });
});
