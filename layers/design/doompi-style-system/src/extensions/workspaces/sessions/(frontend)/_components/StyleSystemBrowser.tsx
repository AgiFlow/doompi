import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';

import type { StyleSystemCatalogView } from '../../../../../types/styleSystemCatalog';
import { styleSystemCatalog } from '../_lib/previewApi';
import {
  authorSourceActionSlot,
  browserPageSize,
  browserSelection,
  filteredComponents,
  forgetBrowserSelection,
  rememberBrowserSelection,
  type BrowserSelection,
} from '../_lib/styleSystemBrowser';
import { StoryPreviewPanel } from './StoryPreviewPanel';

interface StyleSystemBrowserProps extends WebPluginSlotProps {
  initialCatalog?: StyleSystemCatalogView;
}
const controlClass = 'min-w-0 rounded-sm border border-doom-border bg-doom-panel px-2 py-1 text-sm text-doom-text';

export function styleSystemTab(): TransientTab {
  return { id: 'style-system', label: 'style system', panel: StyleSystemBrowser, onClose: forgetBrowserSelection };
}

export function StyleSystemBrowser(props: StyleSystemBrowserProps) {
  const { sessionId } = props;
  const [selection, setSelection] = useState(() => browserSelection(sessionId));
  const [catalog, setCatalog] = useState<StyleSystemCatalogView | undefined>(props.initialCatalog);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(props.initialCatalog === undefined);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setSelection(browserSelection(sessionId));
  }, [sessionId]);
  useEffect(() => {
    if (props.initialCatalog !== undefined && revision === 0) return;
    if (sessionId === null) {
      setLoading(false);
      setCatalog(undefined);
      return;
    }
    let current = true;
    setLoading(true);
    setCatalog(undefined);
    setError('');
    void styleSystemCatalog(sessionId, { refresh: revision > 0 })
      .then((result) => {
        if (!current) return;
        if (result.ok) setCatalog(result.catalog);
        else setError(result.error);
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : 'Unable to discover style systems.');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [sessionId, revision, props.initialCatalog]);

  const update = (patch: Partial<BrowserSelection>): void => {
    const next = { ...selection, ...patch };
    rememberBrowserSelection(sessionId, next);
    setSelection(next);
  };
  const filter = (patch: Partial<BrowserSelection>): void => update({ ...patch, page: 0 });
  const results = catalog === undefined ? [] : filteredComponents(catalog, selection);
  const pages = Math.max(1, Math.ceil(results.length / browserPageSize));
  const page = Math.min(selection.page, pages - 1);
  const component = catalog?.components.find((entry) => entry.storyPath === selection.storyPath);
  const project = catalog?.projects.find((entry) => entry.appPath === selection.appPath);
  const navigationProject = selection.scope.startsWith('project:')
    ? catalog?.projects.find((entry) => entry.appPath === selection.scope.slice(8))
    : undefined;
  const projectsByDirectory = new Map<string, NonNullable<typeof catalog>['projects']>();
  for (const entry of catalog?.projects ?? []) {
    const directory = entry.appPath.includes('/') ? entry.appPath.slice(0, entry.appPath.lastIndexOf('/')) : '.';
    const group = projectsByDirectory.get(directory) ?? [];
    group.push(entry);
    projectsByDirectory.set(directory, group);
  }
  const tags = [...new Set(catalog?.components.flatMap((entry) => entry.tags) ?? [])].sort();
  const presets = [
    ...new Set(catalog?.projects.flatMap((entry) => (entry.preset === undefined ? [] : [entry.preset])) ?? []),
  ].sort();
  const bundlers = [...new Set(catalog?.projects.map((entry) => entry.bundler ?? 'vite-react') ?? [])].sort();
  const action =
    sessionId !== null && props.activeMinorModes?.includes('author')
      ? props.slotData?.(authorSourceActionSlot)?.[0]?.data
      : undefined;
  const chooseComponent = (storyPath: string): void => {
    const chosen = catalog?.components.find((entry) => entry.storyPath === storyPath);
    if (chosen === undefined) return;
    const preferred = chosen.exports.find((entry) => entry.exportName === 'Playground') ?? chosen.exports[0];
    update({ storyPath, appPath: chosen.projectPath ?? '', storyExport: preferred?.exportName ?? '' });
  };
  const clearFilters = (): void => filter({ scope: 'all', search: '', preset: '', bundler: '', tag: '' });

  return (
    <section aria-label="Style system browser" className="flex min-h-0 flex-1 flex-col bg-doom-bg text-doom-text">
      <header className="flex flex-wrap items-center gap-2 border-b border-doom-border px-4 py-3">
        <h1 className="text-lg font-bold">style system</h1>
        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          Search
          <input
            type="search"
            aria-label="Search components"
            placeholder="Component, path, tag, story"
            value={selection.search}
            onChange={(event) => filter({ search: event.target.value })}
            className={`${controlClass} flex-1`}
          />
        </label>
        <Button
          size="xs"
          variant="outline"
          disabled={loading || sessionId === null}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh
        </Button>
      </header>
      {loading ? (
        <p role="status" className="p-4 text-sm text-doom-dim">
          Discovering configurations and components...
        </p>
      ) : null}
      {sessionId === null ? (
        <p className="p-4 text-sm text-doom-dim">Select a session to browse its style systems.</p>
      ) : null}
      {error !== '' ? (
        <p role="alert" className="p-4 text-sm text-doom-red">
          {error}{' '}
          <Button size="xs" onClick={() => setRevision((value) => value + 1)}>
            Retry
          </Button>
        </p>
      ) : null}
      {catalog === undefined ? null : (
        <>
          <div className="flex flex-wrap items-center gap-3 border-b border-doom-border px-4 py-2 text-sm">
            <label>
              Preset{' '}
              <select
                aria-label="Filter by preset"
                className={controlClass}
                value={selection.preset}
                onChange={(event) => filter({ preset: event.target.value })}
              >
                <option value="">All presets</option>
                {presets.map((entry) => (
                  <option key={entry}>{entry}</option>
                ))}
              </select>
            </label>
            <label>
              Bundler{' '}
              <select
                aria-label="Filter by bundler"
                className={controlClass}
                value={selection.bundler}
                onChange={(event) => filter({ bundler: event.target.value })}
              >
                <option value="">All bundlers</option>
                {bundlers.map((entry) => (
                  <option key={entry}>{entry}</option>
                ))}
              </select>
            </label>
            <label>
              Tag{' '}
              <select
                aria-label="Filter by tag"
                className={controlClass}
                value={selection.tag}
                onChange={(event) => filter({ tag: event.target.value })}
              >
                <option value="">All tags</option>
                {tags.map((entry) => (
                  <option key={entry}>{entry}</option>
                ))}
              </select>
            </label>
            <Button size="xs" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
            <span role="status" className="text-doom-dim">
              {results.length} components
            </span>
          </div>
          {catalog.truncated || catalog.diagnostics.length > 0 ? (
            <details className="border-b border-doom-border px-4 py-2 text-sm text-doom-dim">
              <summary>
                {catalog.diagnostics.length} discovery issues{catalog.truncated ? ', catalog limit reached' : ''}
              </summary>
              <ul>
                {catalog.diagnostics.map((entry, index) => (
                  <li key={`${entry.path}:${index}`} className="break-words">
                    {entry.path}: {entry.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-3">
            <nav
              aria-label="Style system configurations"
              className="overflow-auto border-b border-doom-border p-3 lg:border-b-0 lg:border-r"
            >
              {(['all', 'shared', 'unassigned'] as const).map((scope) => (
                <Button
                  key={scope}
                  size="xs"
                  variant={selection.scope === scope ? 'primary' : 'ghost'}
                  className="w-full justify-start"
                  aria-pressed={selection.scope === scope}
                  onClick={() => filter({ scope })}
                >
                  {scope === 'all'
                    ? 'All components'
                    : scope === 'shared'
                      ? 'Shared components'
                      : 'Without project config'}
                </Button>
              ))}
              {catalog.workspace === undefined ? null : (
                <details className="my-3 text-sm text-doom-dim">
                  <summary>Workspace settings</summary>
                  <p>{catalog.workspace.configPath}</p>
                  <pre className="overflow-auto text-xs">{JSON.stringify(catalog.workspace.settings, null, 2)}</pre>
                </details>
              )}
              {[...projectsByDirectory].map(([directory, projects]) => (
                <div key={directory} className="mt-4">
                  <h2 className="mb-1 break-words text-xs uppercase tracking-wide text-doom-dim">{directory}</h2>
                  {projects.map((entry) => (
                    <Button
                      key={entry.appPath}
                      size="xs"
                      variant={selection.scope === `project:${entry.appPath}` ? 'primary' : 'ghost'}
                      className="h-auto w-full justify-start whitespace-normal text-left"
                      aria-pressed={selection.scope === `project:${entry.appPath}`}
                      onClick={() => filter({ scope: `project:${entry.appPath}` })}
                    >
                      <span className="min-w-0 break-words">
                        {entry.appPath}
                        <span className="block text-xs text-doom-dim">
                          {entry.error === undefined
                            ? (entry.preset ?? entry.bundler ?? 'default')
                            : 'Configuration error'}
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              ))}
              {navigationProject === undefined ? null : (
                <details open className="mt-4 text-sm">
                  <summary>Configuration details</summary>
                  <p className="break-words text-doom-dim">{navigationProject.configPath}</p>
                  {navigationProject.error === undefined ? null : (
                    <p role="alert" className="text-doom-red">
                      {navigationProject.error}
                    </p>
                  )}
                  <pre className="overflow-auto text-xs">
                    {JSON.stringify(
                      { provenance: navigationProject.provenance, settings: navigationProject.settings },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </nav>
            <div
              aria-label="Component results"
              className="flex min-h-0 flex-col overflow-auto border-b border-doom-border p-3 lg:border-b-0 lg:border-r"
            >
              {results.length === 0 ? (
                <p className="p-2 text-sm text-doom-dim">
                  {catalog.components.length === 0
                    ? 'No component stories found in this repository.'
                    : 'No components match these filters.'}
                </p>
              ) : null}
              {results.slice(page * browserPageSize, (page + 1) * browserPageSize).map((entry) => (
                <Button
                  key={entry.storyPath}
                  size="xs"
                  variant={selection.storyPath === entry.storyPath ? 'primary' : 'ghost'}
                  aria-pressed={selection.storyPath === entry.storyPath}
                  className="mb-1 h-auto w-full justify-start whitespace-normal text-left"
                  onClick={() => chooseComponent(entry.storyPath)}
                >
                  <span className="min-w-0">
                    <strong className="block break-words">{entry.title}</strong>
                    <span className="block break-words text-xs text-doom-dim">{entry.storyPath}</span>
                    <span className="block text-xs text-doom-dim">
                      {entry.exports.length} stories{entry.tags.length === 0 ? '' : ` · ${entry.tags.join(', ')}`}
                    </span>
                  </span>
                </Button>
              ))}
              {pages > 1 ? (
                <div className="mt-3 flex items-center justify-between gap-2">
                  <Button size="xs" variant="outline" disabled={page === 0} onClick={() => update({ page: page - 1 })}>
                    Previous
                  </Button>
                  <span className="text-xs text-doom-dim">
                    {page + 1} / {pages}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={page + 1 >= pages}
                    onClick={() => update({ page: page + 1 })}
                  >
                    Next
                  </Button>
                </div>
              ) : null}
            </div>
            <div aria-label="Selected component" className="flex min-h-0 flex-col overflow-auto">
              {component === undefined ? (
                <p className="p-4 text-sm text-doom-dim">
                  Choose a component to inspect and preview. Previews render only after selection.
                </p>
              ) : (
                <>
                  <header className="flex flex-col gap-2 border-b border-doom-border p-3">
                    <h2 className="break-words text-base font-bold">{component.title}</h2>
                    <p className="break-words text-xs text-doom-dim">{component.storyPath}</p>
                    <label className="text-sm">
                      Story{' '}
                      <select
                        aria-label="Story export"
                        value={selection.storyExport}
                        className={`${controlClass} w-full`}
                        onChange={(event) => update({ storyExport: event.target.value })}
                      >
                        {component.exports.map((entry) => (
                          <option value={entry.exportName} key={entry.exportName}>
                            {entry.label ?? entry.exportName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm">
                      Rendering project{' '}
                      <select
                        aria-label="Rendering project"
                        value={selection.appPath}
                        className={`${controlClass} w-full`}
                        onChange={(event) => update({ appPath: event.target.value })}
                      >
                        <option value="">Choose consuming project</option>
                        {catalog.projects.map((entry) => (
                          <option key={entry.appPath} value={entry.appPath} disabled={entry.error !== undefined}>
                            {entry.appPath}
                          </option>
                        ))}
                      </select>
                    </label>
                    {component.projectPath === undefined && selection.appPath === '' ? (
                      <p className="text-xs text-doom-dim">
                        This component has no project config. Choose a consuming project to render it.
                      </p>
                    ) : null}
                    {action === undefined || sessionId === null ? null : (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          props.openTransientTab(
                            action.createTab({
                              sessionId,
                              path: component.storyPath,
                              preview:
                                project === undefined || selection.storyExport === ''
                                  ? undefined
                                  : {
                                      appPath: project.appPath,
                                      storyExport: selection.storyExport,
                                      snapshot: project.bundler !== undefined && project.bundler !== 'vite-react',
                                    },
                            }),
                          )
                        }
                      >
                        Open in Author
                      </Button>
                    )}
                  </header>
                  {project === undefined || project.error !== undefined || selection.storyExport === '' ? null : (
                    <StoryPreviewPanel
                      key={`${sessionId}:${selection.appPath}:${selection.storyPath}:${selection.storyExport}:${revision}`}
                      {...props}
                      seed={{
                        appPath: selection.appPath,
                        storyPath: selection.storyPath,
                        storyExport: selection.storyExport,
                        snapshot: project.bundler !== undefined && project.bundler !== 'vite-react',
                        source: { path: selection.storyPath, hasUnsavedChanges: false },
                      }}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
