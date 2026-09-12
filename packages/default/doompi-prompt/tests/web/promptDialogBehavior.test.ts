import { renderPlugin } from '@agimon-ai/doompi-core/web/testing';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedPromptView } from '../../src/types/webPrompts';
import { PromptsDialog } from '../../src/web/components/PromptsDialog';

const captured = vi.hoisted(() => ({
  buttons: [] as Array<Record<string, unknown>>,
  contents: [] as Array<Record<string, unknown>>,
  inputs: [] as Array<Record<string, unknown>>,
  textareas: [] as Array<Record<string, unknown>>,
}));

const api = vi.hoisted(() => ({
  remove: vi.fn(async () => undefined),
  save: vi.fn(async () => undefined),
}));

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));
vi.mock('../../src/web/api/promptsApi', () => ({
  deleteSavedPrompt: api.remove,
  saveSavedPrompt: api.save,
}));

vi.mock('@agimon-ai/doompi-web-components', () => {
  const shell = (tag: string) =>
    function Shell({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) {
      return createElement(tag, { 'data-testid': props['data-testid'] }, children);
    };

  return {
    Button(props: Record<string, unknown>) {
      captured.buttons.push(props);
      return createElement(
        'button',
        { 'data-testid': props['data-testid'], disabled: props.disabled },
        props.children as ReactNode,
      );
    },
    Input(props: Record<string, unknown>) {
      captured.inputs.push(props);
      return createElement('input', { 'data-testid': props['data-testid'], value: props.value, readOnly: true });
    },
    Textarea(props: Record<string, unknown>) {
      captured.textareas.push(props);
      return createElement('textarea', { 'data-testid': props['data-testid'], value: props.value, readOnly: true });
    },
    Dialog({ open, children }: { open?: boolean; children?: ReactNode }) {
      return open ? createElement('div', null, children) : null;
    },
    DialogBody: shell('div'),
    DialogContent(props: Record<string, unknown>) {
      captured.contents.push(props);
      return createElement('section', { 'data-testid': props['data-testid'] }, props.children as ReactNode);
    },
    DialogDescription: shell('p'),
    DialogFooter: shell('footer'),
    DialogHeader: shell('header'),
    DialogTitle: shell('h2'),
  };
});

const PROMPT: SavedPromptView = { name: 'review', description: 'Review the change', text: 'Review the change' };

function props(overrides: Partial<Parameters<typeof PromptsDialog>[0]> = {}): Parameters<typeof PromptsDialog>[0] {
  return {
    open: true,
    prompts: [PROMPT],
    loading: false,
    loadError: '',
    sessionId: 'session-1',
    onOpenChange: vi.fn(),
    onReload: vi.fn(async () => undefined),
    onSend: vi.fn(),
    ...overrides,
  };
}

function button(testId: string): Record<string, unknown> {
  const found = captured.buttons.find((candidate) => candidate['data-testid'] === testId);
  if (!found) throw new Error(`Missing button ${testId}`);
  return found;
}

function control(controls: Array<Record<string, unknown>>, index: number, label: string): Record<string, unknown> {
  const found = controls[index];
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}

beforeEach(() => {
  captured.buttons.length = 0;
  captured.contents.length = 0;
  captured.inputs.length = 0;
  captured.textareas.length = 0;
  api.remove.mockClear();
  api.save.mockClear();
});

describe('prompt dialog behavior', () => {
  it('sends a selected prompt to the focused session and closes', () => {
    const dialogProps = props();
    const rendered = renderPlugin(PromptsDialog, dialogProps);

    expect(rendered.error).toBeUndefined();
    const preventDefault = vi.fn();
    (
      control(captured.contents, 0, 'dialog content').onOpenAutoFocus as (event: { preventDefault: () => void }) => void
    )({ preventDefault });
    (control(captured.inputs, 0, 'filter input').onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'rev' },
    });
    (button('prompts-edit-review').onClick as () => void)();
    (button('prompts-delete-review').onClick as () => void)();
    (button('prompts-new').onClick as () => void)();
    (button('prompts-send-review').onClick as () => void)();

    expect(dialogProps.onSend).toHaveBeenCalledWith('session-1', { type: 'prompt', message: PROMPT.text });
    expect(dialogProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open when no session is focused', () => {
    const dialogProps = props({ sessionId: null });
    renderPlugin(PromptsDialog, dialogProps);

    (button('prompts-send-review').onClick as () => void)();

    expect(dialogProps.onSend).not.toHaveBeenCalled();
    expect(dialogProps.onOpenChange).not.toHaveBeenCalled();
  });

  it('prefills and saves a user-message draft without losing its text', async () => {
    const onReload = vi.fn(async () => undefined);
    const dialogProps = props({
      prompts: [],
      initialDraft: { name: 'saved-message', text: 'Keep this exact text', original: '' },
      onReload,
    });
    const rendered = renderPlugin(PromptsDialog, dialogProps);

    expect(rendered.includes('Keep this exact text')).toBe(true);
    expect(captured.inputs[0]?.value).toBe('saved-message');
    const preventDefault = vi.fn();
    (
      control(captured.contents, 0, 'dialog content').onOpenAutoFocus as (event: { preventDefault: () => void }) => void
    )({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    (button('prompts-save').onClick as () => void)();

    await vi.waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    expect(api.save).toHaveBeenCalledWith('saved-message', 'Keep this exact text', 'session-1');
  });

  it('exposes editable name and text controls for a message draft', () => {
    renderPlugin(
      PromptsDialog,
      props({ prompts: [], initialDraft: { name: '', text: 'Original text', original: '' } }),
    );
    const onNameChange = captured.inputs[0]?.onChange as (event: { target: { value: string } }) => void;
    const onTextChange = captured.textareas[0]?.onChange as (event: { target: { value: string } }) => void;

    onNameChange({ target: { value: 'new-name' } });
    onTextChange({ target: { value: 'Changed text' } });
    (button('prompts-cancel').onClick as () => void)();
  });

  it('renders retry while loading the library failed', () => {
    const onReload = vi.fn(async () => undefined);
    const rendered = renderPlugin(PromptsDialog, props({ prompts: [], loadError: 'unavailable', onReload }));

    expect(rendered.includes('unavailable')).toBe(true);
    (button('prompts-retry').onClick as () => void)();
    expect(onReload).toHaveBeenCalledOnce();
  });
});
