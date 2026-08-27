import { defineWebPlugin, type ToolPromptDialog } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { installWebPlugins, resetWebPlugins } from '../../src/web/lib/pluginRegistry.ts';
import { initialSessionState, type SessionState, type ToolEntry } from '../../src/web/lib/sessionModel.ts';
import { toolPromptClaim } from '../../src/web/lib/toolPrompt.ts';

function Component(): null {
  return null;
}

const REQUEST = {
  id: 'req-1',
  method: 'select' as const,
  title: 'Which one?',
  message: '',
  options: ['a', 'b'],
  placeholder: '',
  prefill: '',
};

function tool(patch: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id: 't1',
    toolCallId: 'call-1',
    name: 'ask_user_question',
    args: { questions: [{ question: 'Which one?' }] },
    argSummary: '',
    result: null,
    output: '',
    isError: false,
    running: true,
    ...patch,
  };
}

function state(patch: Partial<SessionState> = {}): SessionState {
  return { ...initialSessionState, dialog: REQUEST, entries: [tool()], ...patch };
}

/** A plugin owning ask_user_question, with the prompt it declares. */
function install(prompt?: { claims?: (dialog: ToolPromptDialog, args: Record<string, unknown>) => boolean }): void {
  installWebPlugins([
    defineWebPlugin({
      id: 'ask-user',
      toolRenderers: [
        {
          tools: ['ask_user_question'],
          message: Component,
          ...(prompt === undefined ? {} : { prompt: { ...prompt, component: Component } }),
        },
      ],
    }),
  ]);
}

afterEach(() => resetWebPlugins());

describe('which running tool owns the open request', () => {
  it('claims it for the running tool whose plugin declared a prompt', () => {
    install({});
    const claim = toolPromptClaim(state(), null);

    expect(claim?.entry.toolCallId).toBe('call-1');
    expect(claim?.dialog).toEqual(REQUEST);
  });

  it('claims nothing when no request is open', () => {
    install({});
    expect(toolPromptClaim(state({ dialog: null }), null)).toBeNull();
  });

  it('claims nothing when the tool declared no prompt', () => {
    install();
    expect(toolPromptClaim(state(), null)).toBeNull();
  });

  it('claims nothing when no plugin owns the tool at all', () => {
    install({});
    expect(toolPromptClaim(state({ entries: [tool({ name: 'bash' })] }), null)).toBeNull();
  });

  it('claims nothing when the tool has already finished', () => {
    install({});
    expect(toolPromptClaim(state({ entries: [tool({ running: false })] }), null)).toBeNull();
  });

  it('leaves a request another surface already spoke for', () => {
    install({});
    expect(toolPromptClaim(state(), REQUEST.id)).toBeNull();
    // A claim on some other request says nothing about this one.
    expect(toolPromptClaim(state(), 'req-other')).not.toBeNull();
  });

  it('leaves a request the prompt itself refuses', () => {
    install({ claims: (dialog) => dialog.title === 'something else' });
    expect(toolPromptClaim(state(), null)).toBeNull();
  });

  it('passes the request and the call to the prompt so it can recognise its own', () => {
    const seen: Array<{ title: string; args: Record<string, unknown> }> = [];
    install({
      claims: (dialog, args) => {
        seen.push({ title: dialog.title, args });
        return true;
      },
    });

    expect(toolPromptClaim(state(), null)).not.toBeNull();
    expect(seen).toEqual([{ title: 'Which one?', args: { questions: [{ question: 'Which one?' }] } }]);
  });

  it('reads the newest running tool, so a later call wins over an earlier one', () => {
    install({ claims: (_dialog, args) => Array.isArray(args.questions) });
    const stale = tool({ id: 't0', toolCallId: 'call-0', args: {} });
    const fresh = tool({ id: 't2', toolCallId: 'call-2' });

    expect(toolPromptClaim(state({ entries: [stale, fresh] }), null)?.entry.toolCallId).toBe('call-2');
    // The newest one refusing does not hand the request to the older one's
    // prompt: the search keeps going, which is the only way a tool that opened
    // no request stays out of the way.
    expect(toolPromptClaim(state({ entries: [fresh, stale] }), null)?.entry.toolCallId).toBe('call-2');
  });
});
