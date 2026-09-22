import type { WebPluginDefinition, WebTemplateContribution } from '@agimon-ai/doompi-core/web';
import { afterEach, describe, expect, it } from 'vitest';

import {
  activateWebPluginSession,
  bindSessionWebWorkspace,
  installGlobalWebPlugins,
  installSessionWebPlugins,
  installWorkspaceWebPlugins,
  removeWorkspaceWebPlugins,
  resetWebPlugins,
  webTemplateCatalog,
} from '../../src/web/lib/pluginRegistry';
import { collectWebTemplates, resolveWebTemplate } from '../../src/web/lib/templateCatalog';

const template = (id: string): WebTemplateContribution => ({
  id,
  label: id,
  description: 'Test layout',
  contractVersion: 1,
  layout: () => null,
});
const plugin = (id: string, templates: WebTemplateContribution[]): WebPluginDefinition => ({ id, templates });
afterEach(resetWebPlugins);

describe('template catalog', () => {
  it('discovers an independent package and keeps first ownership on duplicate IDs', () => {
    const catalog = collectWebTemplates([
      plugin('acme', [template('acme-layout')]),
      plugin('other', [template('acme-layout'), template('other-layout')]),
    ]);
    expect(catalog.templates.map((entry) => [entry.id, entry.pluginId])).toEqual([
      ['acme-layout', 'acme'],
      ['other-layout', 'other'],
    ]);
    expect(catalog.diagnostics[0]?.kind).toBe('duplicate-template');
  });

  it('isolates bad metadata and unsupported contracts', () => {
    const bad = { ...template('old'), contractVersion: 99 } as unknown as WebTemplateContribution;
    const throwing: WebPluginDefinition = {
      id: 'throwing',
      get templates(): WebTemplateContribution[] {
        throw new Error('broken metadata');
      },
    };
    const catalog = collectWebTemplates([throwing, plugin('bad', [bad]), plugin('good', [template('good-layout')])]);
    expect(catalog.templates.map((entry) => entry.id)).toEqual(['good-layout']);
    expect(catalog.diagnostics.map((entry) => entry.kind)).toEqual(['invalid-template', 'invalid-template']);
  });

  it('resolves configured, Advanced, deterministic fallback, and recovery without rewriting the ID', () => {
    const templates = collectWebTemplates([
      plugin('layouts', [template('z-layout'), template('a-layout'), template('doompi-template-advanced')]),
    ]).templates;
    expect(resolveWebTemplate(templates, 'z-layout').template?.id).toBe('z-layout');
    expect(resolveWebTemplate(templates, 'missing').template?.id).toBe('doompi-template-advanced');
    expect(resolveWebTemplate(templates, 'missing').warning).toContain('missing');
    expect(resolveWebTemplate(templates, undefined, ['doompi-template-advanced']).template?.id).toBe('a-layout');
    expect(resolveWebTemplate([], 'missing').template).toBeUndefined();
  });

  it('defaults to Advanced regardless of template order and keeps Elegant opt-in', () => {
    const advanced = template('doompi-template-advanced');
    const elegant = template('doompi-template-elegant');
    for (const entries of [
      [advanced, elegant],
      [elegant, advanced],
    ]) {
      const { templates } = collectWebTemplates([plugin('layouts', entries)]);
      expect(resolveWebTemplate(templates, undefined)).toEqual({
        template: templates.find((entry) => entry.id === advanced.id),
        warning: undefined,
      });
      expect(resolveWebTemplate(templates, elegant.id).template?.id).toBe(elegant.id);
    }
  });
  it('keeps workspace and session contributions out of unrelated Settings catalogs', () => {
    installGlobalWebPlugins([{ id: 'global-layout', global: { templates: [template('global-layout')] } }]);
    installWorkspaceWebPlugins('one', [
      { id: 'workspace-layout', workspace: { templates: [template('workspace-layout')] } },
    ]);
    bindSessionWebWorkspace('s1', 'one');
    installSessionWebPlugins('s1', [{ id: 'session-layout', session: { templates: [template('session-layout')] } }]);
    activateWebPluginSession('s1');
    const ids = (catalog: ReturnType<typeof webTemplateCatalog>) => catalog.templates.map((entry) => entry.id);
    expect(ids(webTemplateCatalog({ scope: 'global' }))).toEqual(['global-layout']);
    expect(ids(webTemplateCatalog({ scope: 'workspace', workspaceId: 'two' }))).toEqual(['global-layout']);
    expect(ids(webTemplateCatalog({ scope: 'workspace', workspaceId: 'one' }))).toEqual([
      'global-layout',
      'workspace-layout',
    ]);
    expect(ids(webTemplateCatalog({ scope: 'session', workspaceId: 'one', sessionId: 's1' }))).toEqual([
      'global-layout',
      'workspace-layout',
      'session-layout',
    ]);
    removeWorkspaceWebPlugins('one');
    expect(ids(webTemplateCatalog({ scope: 'workspace', workspaceId: 'one' }))).toEqual(['global-layout']);
  });
});
