import { describe, expect, it, vi } from 'vitest';

import { parseAuthorPreviewAction } from '../../src/types/authorPreview';

const createTab = vi.fn();

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
