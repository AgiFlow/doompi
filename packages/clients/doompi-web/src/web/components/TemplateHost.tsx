import type { WebPluginMount, WebTemplateContribution, WebTemplateProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { Link } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { Component, type ReactNode, useState } from 'react';

import { webTemplateCatalog } from '../lib/pluginRegistry';
import { webPluginCompositionStore } from '../lib/pluginRuntime';
import { resolveWebTemplate } from '../lib/templateCatalog';
import { configuredTemplate, useTemplateConfiguration } from '../stores/templateStore';
import { useWebPluginRegistry } from '../stores/useWebPluginRegistry';

class TemplateBoundary extends Component<{ children: ReactNode; onFailure(): void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onFailure();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Runtime and mandatory overlays are above this boundary, not owned by a template package. */
export function TemplateHost({ mount, ...props }: WebTemplateProps & { mount?: WebPluginMount }) {
  useWebPluginRegistry();
  const workspaceId = mount?.scope === 'workspace' || mount?.scope === 'session' ? mount.workspaceId : undefined;
  const configuration = useTemplateConfiguration(workspaceId);
  const compositionPhase = useStore(webPluginCompositionStore, (state) => state.phase);
  const [failures, setFailures] = useState<WebTemplateContribution[]>([]);
  const catalog = webTemplateCatalog(mount);
  // Registry updates are not layout changes. Retry a failed package only after
  // its implementation changes or the user explicitly asks, without remounting healthy content.
  const failed = catalog.templates
    .filter((entry) => failures.some((failure) => failure.id === entry.id && failure.layout === entry.layout))
    .map((entry) => entry.id);
  const { template, warning } = resolveWebTemplate(catalog.templates, configuredTemplate(configuration), failed);
  const [selected, setSelected] = useState<WebTemplateContribution | undefined>(template);
  const selectedFailed =
    selected !== undefined &&
    failures.some((failure) => failure.id === selected.id && failure.layout === selected.layout);
  if (
    (template === undefined &&
      selected !== undefined &&
      compositionPhase !== 'idle' &&
      compositionPhase !== 'loading') ||
    (template !== undefined && (selected === undefined || selected.id !== template.id || selectedFailed))
  )
    setSelected(template);
  const diagnostic = warning ?? catalog.diagnostics[0]?.message ?? configuration.error;
  const Layout = selected?.layout;
  const initializing = Layout === undefined && (compositionPhase === 'idle' || compositionPhase === 'loading');
  return (
    <div data-template={selected?.id ?? 'recovery'} className="flex h-full min-w-0 flex-col overflow-hidden">
      {diagnostic ? (
        <div
          role="status"
          data-testid="template-diagnostic"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-doom-border bg-doom-panel px-3 py-2 text-sm text-doom-dim"
        >
          <span className="flex-1">{diagnostic}</span>
          <Link to="/settings/$section" params={{ section: 'appearance' }} search={{ workspace: workspaceId }}>
            Template settings
          </Link>
          {failed.length > 0 ? (
            <Button size="xs" variant="ghost" onClick={() => setFailures([])}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1">
        {Layout && selected ? (
          <TemplateBoundary key={selected.id} onFailure={() => setFailures((state) => [...state, selected])}>
            <Layout {...props} />
          </TemplateBoundary>
        ) : initializing ? (
          <div
            data-testid="template-loading"
            role="status"
            className="flex h-full items-center justify-center text-sm text-doom-dim"
          >
            loading web template…
          </div>
        ) : (
          <div data-testid="template-recovery" className="flex h-full min-w-0 flex-col overflow-hidden">
            {props.slots.notices}
            {props.slots.header({ navigationToggle: 'always', activityToggle: 'always' })}
            <div className="flex min-h-0 min-w-0 flex-1">
              <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                {props.view === 'settings' ? (
                  props.slots.content
                ) : (
                  <div className="flex flex-col gap-3 p-5 text-base">
                    <h1 className="font-bold text-doom-hi">Web template unavailable</h1>
                    <p>Install a compatible template package through modes.yaml, then sync the composition.</p>
                    <Link
                      to="/settings/$section"
                      params={{ section: 'appearance' }}
                      search={{ workspace: workspaceId }}
                    >
                      Open template settings
                    </Link>
                    <p className="text-sm text-doom-dim">Your sessions continue running independently of this view.</p>
                  </div>
                )}
              </main>
              {props.slots.activity}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
