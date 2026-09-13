import { renderPlugin, slotPropsFixture } from '@agimon-ai/doompi-core/web/testing';
import { describe, expect, it, vi } from 'vitest';

import type { SavedPromptView } from '../../src/types/webPrompts';
import { PromptEditor } from '../../src/web/components/PromptEditor';
import { PromptPickerList } from '../../src/web/components/PromptPickerList';
import { PromptsComposerMenuItem } from '../../src/web/components/PromptsComposerMenuItem';
import { PromptsDialogHost } from '../../src/web/components/PromptsDialogHost';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));

const PROMPT: SavedPromptView = { name: 'review', description: 'Review the diff', text: 'Review the diff\nnow' };

describe('the composer menu entry', () => {
  it('offers the library as one menu row', () => {
    const rendered = renderPlugin(PromptsComposerMenuItem, {});

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('composer-menu-prompts');
    expect(rendered.includes('Prompt template')).toBe(true);
  });

  it('sits in a menu rather than a list of choices', () => {
    const rendered = renderPlugin(PromptsComposerMenuItem, {});

    expect(rendered.html).toContain('role="menuitem"');
  });
});

describe('the prompts dialog host', () => {
  it('renders nothing until something asks for the library', () => {
    const { props } = slotPropsFixture();

    const rendered = renderPlugin(PromptsDialogHost, props);

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).not.toContain('prompts-dialog');
  });

  it('mounts with no session focused', () => {
    const { props } = slotPropsFixture({ sessionId: null });

    expect(renderPlugin(PromptsDialogHost, props).error).toBeUndefined();
  });
});

describe('the prompt picker list', () => {
  const listProps = (overrides: Partial<Parameters<typeof PromptPickerList>[0]> = {}) => ({
    prompts: [PROMPT],
    filter: '',
    loading: false,
    busy: false,
    error: '',
    onFilterChange: vi.fn(),
    onSend: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  });

  it('lists a saved prompt as the command it also is', () => {
    const rendered = renderPlugin(PromptPickerList, listProps());

    expect(rendered.error).toBeUndefined();
    expect(rendered.includes('/review')).toBe(true);
    expect(rendered.includes('Review the diff')).toBe(true);
  });

  it('offers sending, editing and removing each entry', () => {
    const rendered = renderPlugin(PromptPickerList, listProps());

    expect(rendered.html).toContain('prompts-send-review');
    expect(rendered.html).toContain('prompts-edit-review');
    expect(rendered.html).toContain('prompts-delete-review');
    expect(rendered.includes('remove')).toBe(true);
  });

  it('says so when the library is empty', () => {
    const rendered = renderPlugin(PromptPickerList, listProps({ prompts: [] }));

    expect(rendered.includes('no saved prompts yet')).toBe(true);
  });

  it('tells an empty filter result apart from an empty library', () => {
    const rendered = renderPlugin(PromptPickerList, listProps({ filter: 'zzz' }));

    expect(rendered.includes('nothing matches that filter')).toBe(true);
  });

  it('shows the failure the dialog handed it', () => {
    const rendered = renderPlugin(PromptPickerList, listProps({ error: 'The hub answered 404.' }));

    expect(rendered.includes('The hub answered 404.')).toBe(true);
  });

  it('never shows the prompt body in a row', () => {
    const rendered = renderPlugin(PromptPickerList, listProps());

    expect(rendered.includes('now')).toBe(false);
  });

  it('shows loading separately from an empty library', () => {
    const rendered = renderPlugin(PromptPickerList, listProps({ prompts: [], loading: true }));

    expect(rendered.html).toContain('prompts-loading');
    expect(rendered.html).not.toContain('prompts-empty');
  });
});

describe('the editor', () => {
  const editorProps = (draft = { name: 'review', text: 'body', original: 'review' }, busy = false) => ({
    draft,
    busy,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
  });

  it('renders the draft it was given', () => {
    const rendered = renderPlugin(PromptEditor, editorProps());

    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('prompts-name');
    expect(rendered.html).toContain('prompts-text');
  });

  it('disables save for an incomplete draft', () => {
    const rendered = renderPlugin(PromptEditor, editorProps({ name: '', text: '', original: '' }));

    expect(rendered.html).toContain('disabled');
  });

  it('disables save while a write is in flight', () => {
    const rendered = renderPlugin(PromptEditor, editorProps(undefined, true));

    expect(rendered.html).toContain('disabled');
  });
});
