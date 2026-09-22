import type { WebPluginMount, WebTemplateContribution, WebTemplateProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { Link } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { Component, type ReactNode, useState } from 'react';

import { webTemplateCatalog } from '../lib/pluginRegistry';
import { retryWebPluginCompositions, webPluginCompositionStore, webPluginMountState } from '../lib/pluginRuntime';
import { resolveWebTemplate } from '../lib/templateCatalog';
import { configuredTemplate, refreshTemplateConfiguration, useTemplateConfiguration } from '../stores/templateStore';
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

function templateMountKey(mount: WebPluginMount): string {
  return mount.scope === 'global'
    ? 'global'
    : mount.scope === 'workspace'
      ? `workspace:${mount.workspaceId}`
      : `session:${mount.sessionId}`;
}

/** Runtime and mandatory overlays are above this boundary, not owned by a template package. */
export function TemplateHost({
  mount,
  scopeReady = true,
  ...props
}: WebTemplateProps & { mount?: WebPluginMount; scopeReady?: boolean }) {
  useWebPluginRegistry();
  const requestedMount: WebPluginMount = mount ?? { scope: 'global' };
  const requestedMountKey = templateMountKey(requestedMount);
  const workspaceId =
    requestedMount.scope === 'workspace' || requestedMount.scope === 'session' ? requestedMount.workspaceId : undefined;
  const configuration = useTemplateConfiguration(workspaceId);
  const composition = useStore(webPluginCompositionStore, (state) => state);
  const mountReadiness = webPluginMountState(requestedMount, composition);
  const [failures, setFailures] = useState<WebTemplateContribution[]>([]);
  const catalog = webTemplateCatalog(requestedMount);
  // Registry updates are not layout changes. Retry a failed package only after
  // its implementation changes or the user explicitly asks, without remounting healthy content.
  const failed = catalog.templates
    .filter((entry) => failures.some((failure) => failure.id === entry.id && failure.layout === entry.layout))
    .map((entry) => entry.id);
  const { template, warning } = resolveWebTemplate(catalog.templates, configuredTemplate(configuration), failed);
  const [selected, setSelected] = useState<{ mountKey: string; template?: WebTemplateContribution }>({
    mountKey: requestedMountKey,
  });
  const selectedTemplate = scopeReady && selected.mountKey === requestedMountKey ? selected.template : undefined;
  const selectedFailed =
    selectedTemplate !== undefined &&
    failures.some((failure) => failure.id === selectedTemplate.id && failure.layout === selectedTemplate.layout);
  const configurationPending = configuration.loading && configuration.config === undefined;
  const loadError = mountReadiness.error ?? configuration.error;
  const hasLoadError = mountReadiness.phase === 'error' || loadError !== undefined;
  // A verified scope must wait for healthy bootstrap, but an error can immediately
  // render the bundled fallback while the failed request is retried.
  const waiting =
    !scopeReady ||
    (!hasLoadError && (configurationPending || mountReadiness.phase === 'idle' || mountReadiness.phase === 'loading'));
  const pending = selectedTemplate === undefined && waiting;
  if (
    !waiting &&
    ((template === undefined && selectedTemplate !== undefined) ||
      (template !== undefined &&
        (selectedTemplate === undefined || selectedTemplate.id !== template.id || selectedFailed)))
  )
    setSelected({ mountKey: requestedMountKey, template });
  const diagnostic = loadError ?? (waiting ? undefined : (warning ?? catalog.diagnostics[0]?.message));
  const Layout = selectedTemplate?.layout;
  return (
    <div
      data-template={selectedTemplate?.id ?? (pending ? 'loading' : 'recovery')}
      className="flex h-full min-w-0 flex-col overflow-hidden"
    >
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
          {loadError ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                if (configuration.error) void refreshTemplateConfiguration(workspaceId);
                if (mountReadiness.error) void retryWebPluginCompositions().catch(() => undefined);
              }}
            >
              Retry templates
            </Button>
          ) : failed.length > 0 ? (
            <Button size="xs" variant="ghost" onClick={() => setFailures([])}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1">
        {Layout && selectedTemplate ? (
          <TemplateBoundary
            key={`${requestedMountKey}:${selectedTemplate.id}`}
            onFailure={() => setFailures((state) => [...state, selectedTemplate])}
          >
            <Layout {...props} />
          </TemplateBoundary>
        ) : pending ? (
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
                    <h1 className="font-bold text-doom-hi">
                      {loadError ? 'Web template failed to load' : 'Web template unavailable'}
                    </h1>
                    <p>
                      {loadError
                        ? 'Retry loading the template or open Settings to review the configuration.'
                        : 'No compatible web template is available. Open Settings to choose a template.'}
                    </p>
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
