import { describe, expect, it, vi } from 'vitest';

import { parseAuthorOpenSourceAction, parseAuthorPreviewAction } from '../../src/types/authorPreview';

const createTab = vi.fn();

describe('parseAuthorOpenSourceAction', () => {
  it.each([null, {}, { version: 2, createTab }, { version: 1, createTab: true }])(
    'rejects invalid actions',
    (input) => {
      expect(parseAuthorOpenSourceAction(input)).toBeNull();
    },
  );
  it('accepts the explicit Author handoff', () => {
    const action = { version: 1, createTab } as const;
    expect(parseAuthorOpenSourceAction(action)).toBe(action);
  });
});

describe('parseAuthorPreviewAction', () => {
  it.each([
    null,
    'preview',
    {},
    { version: 2, label: 'Preview', createTab },
    { version: 1, createTab },
    { version: 1, label: '   ', createTab },
    { version: 1, label: 'Preview', detail: 1, createTab },
    { version: 1, label: 'Preview' },
    { version: 1, label: 'Preview', createTab, supportsSource: true },
    { version: 1, label: 'Preview', createTab, embeddedPanel: true },
  ])('rejects an invalid preview action', (value) => {
    expect(parseAuthorPreviewAction(value)).toBeNull();
  });

  it('accepts minimal and complete preview actions', () => {
    const minimal = { version: 1, label: 'Preview', createTab } as const;
    const complete = {
      ...minimal,
      detail: 'Render the selected story',
      supportsSource: vi.fn(),
      embeddedPanel: vi.fn(),
    };

    expect(parseAuthorPreviewAction(minimal)).toBe(minimal);
    expect(parseAuthorPreviewAction(complete)).toBe(complete);
  });
});
