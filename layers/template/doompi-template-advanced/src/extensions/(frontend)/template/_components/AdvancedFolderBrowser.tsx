import type { WebTemplateRailActions, WebTemplateRailDirectoryListing } from '@agimon-ai/doompi-core/web';
import { Button, ChevronUpIcon, OptionRow } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';

function folderName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/** Walks the server's folders inline: up, into a child, or pick the current folder. */
export function AdvancedFolderBrowser({
  start,
  listDirectory,
  onSelect,
}: {
  /** Folder to open first; home when absent. */
  start?: string;
  listDirectory: WebTemplateRailActions['listDirectory'];
  onSelect: (path: string) => void;
}) {
  const [target, setTarget] = useState(start);
  const [listing, setListing] = useState<WebTemplateRailDirectoryListing | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stale = false;
    void listDirectory(target).then((result) => {
      if (stale) return;
      if ('error' in result) setError(result.error);
      else {
        setError('');
        setListing(result);
      }
    });
    return () => {
      stale = true;
    };
  }, [target, listDirectory]);

  return (
    <div
      data-testid="folder-browser"
      className="flex flex-col gap-1 rounded border border-doom-border bg-doom-deep p-1"
    >
      <div className="flex items-center gap-1 px-1">
        <Button
          variant="ghost"
          size="icon"
          data-testid="folder-browser-up"
          title="parent folder"
          aria-label="parent folder"
          disabled={listing?.parent === undefined}
          onClick={() => listing?.parent !== undefined && setTarget(listing.parent)}
        >
          <ChevronUpIcon className="h-3 w-3" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-doom-dim" title={listing?.path}>
          {listing?.path ?? 'loading…'}
        </span>
        <Button
          variant="outline"
          size="xs"
          data-testid="folder-browser-select"
          disabled={listing === null}
          onClick={() => listing !== null && onSelect(listing.path)}
        >
          use this folder
        </Button>
      </div>
      {error ? <p className="px-2 py-1 text-xs text-doom-red">{error}</p> : null}
      <div role="listbox" aria-label="folders" className="max-h-40 overflow-y-auto">
        {listing !== null && listing.directories.length === 0 ? (
          <p className="px-2 py-1 text-2xs text-doom-faint">no folders here</p>
        ) : null}
        {listing?.directories.map((directory) => (
          <OptionRow
            key={directory}
            density="compact"
            data-testid="folder-browser-entry"
            onClick={() => setTarget(directory)}
            className="w-full px-2.5 py-1 text-sm"
          >
            {folderName(directory)}
          </OptionRow>
        ))}
      </div>
    </div>
  );
}
