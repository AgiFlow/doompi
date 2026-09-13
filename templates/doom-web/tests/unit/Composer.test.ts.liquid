import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/web/components/PluginSurface.tsx', () => ({
  PluginSurface: () => createElement('i', { 'data-testid': 'plugin-composer-action' }),
}));

import { Composer } from '../../src/web/features/session/Composer.tsx';

describe('Composer plugin actions', () => {
  it('renders one action surface without hiding it at either breakpoint', () => {
    const markup = renderToStaticMarkup(createElement(Composer));

    expect(markup.match(/data-testid="plugin-composer-action"/g)).toHaveLength(1);
    expect(markup).toContain('data-testid="composer-actions"');
    expect(markup).not.toMatch(/data-testid="composer-actions"[^>]*sm:hidden/);
  });
});
