import type { TransientTab, WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { Button } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';

import type { StyleSystemCatalogView } from '../../../../../types/styleSystemCatalog';
import { styleSystemCatalog } from '../_lib/previewApi';
import {
  authorSourceActionSlot,
  browserSelection,
  componentKeywords,
  filteredComponents,
  forgetBrowserSelection,
  rememberBrowserSelection,
  storyFolders,
  type BrowserSelection,
} from '../_lib/styleSystemBrowser';
import { Combobox } from './Combobox';
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
  const results = catalog === undefined ? [] : filteredComponents(catalog, selection);
  const component = catalog?.components.find((entry) => entry.storyPath === selection.storyPath);
  const project = catalog?.projects.find((entry) => entry.appPath === selection.appPath);
  const folders = storyFolders(catalog?.components ?? []);
  const tags = [...new Set(catalog?.components.flatMap((entry) => entry.tags) ?? [])].sort();
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
  const toggleTag = (tag: string): void =>
    update({
      tags:
        tag === ''
          ? []
          : selection.tags.includes(tag)
            ? selection.tags.filter((entry) => entry !== tag)
            : [...selection.tags, tag],
    });

  return (
    <section aria-label="Style system browser" className="flex min-h-0 flex-1 flex-col bg-doom-bg text-doom-text">
      <header className="flex flex-wrap items-center gap-2 border-b border-doom-border px-4 py-2">
        <h1 className="mr-2 text-lg font-bold">style system</h1>
        {catalog === undefined ? null : (
          <>
            <Combobox
              label="Folder"
              placeholder="All folders"
              className="w-64"
              options={[
                { value: '', label: 'All folders', detail: `${catalog.components.length} components` },
                ...folders.map((entry) => ({
                  value: entry.path,
                  label: entry.label,
                  fullLabel: entry.path,
                  depth: entry.depth,
                  detail: `${entry.count} components`,
                })),
              ]}
              selected={[selection.folder]}
              onSelect={(folder) => update({ folder })}
            />
            <Combobox
              label="Component"
              placeholder={`Choose one of ${results.length} components`}
              className="min-w-48 flex-1"
              options={results.map((entry) => ({
                value: entry.storyPath,
                label: entry.title,
                detail: entry.storyPath,
                keywords: componentKeywords(entry),
              }))}
              selected={[selection.storyPath]}
              onSelect={chooseComponent}
            />
            <Combobox
              label="Tags"
              placeholder="All tags"
              className="w-48"
              multiple
              options={[{ value: '', label: 'Any tag' }, ...tags.map((tag) => ({ value: tag, label: tag }))]}
              selected={selection.tags.length === 0 ? [''] : selection.tags}
              onSelect={toggleTag}
            />
          </>
        )}
        <Button
          size="sm"
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
          <div aria-label="Selected component" className="flex min-h-0 flex-1 flex-col overflow-auto">
            {component === undefined ? (
              <p className="p-4 text-sm text-doom-dim">
                Choose a component to inspect and preview. Previews render only after selection.
              </p>
            ) : (
              <>
                <header className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-doom-border px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="break-words text-base font-bold">{component.title}</h2>
                    <p className="break-words text-xs text-doom-dim">{component.storyPath}</p>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    Story
                    <select
                      aria-label="Story export"
                      value={selection.storyExport}
                      className={`${controlClass} w-48`}
                      onChange={(event) => update({ storyExport: event.target.value })}
                    >
                      {component.exports.map((entry) => (
                        <option value={entry.exportName} key={entry.exportName}>
                          {entry.label ?? entry.exportName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    Project
                    <select
                      aria-label="Rendering project"
                      value={selection.appPath}
                      className={`${controlClass} w-64`}
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
                    <p className="basis-full text-xs text-doom-dim">
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
        </>
      )}
    </section>
  );
}
