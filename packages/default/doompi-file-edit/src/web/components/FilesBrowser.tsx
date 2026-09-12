import { Button, CloseIcon, Input } from '@agimon-ai/doompi-web-components';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { FilesItemView } from '../../types/webFiles';
import { filterFileItems, groupFileItems, groupRowLabel, TOOL_LABEL } from '../lib/fileView';

function FileMetadata({ item, label, recent = false }: { item: FilesItemView; label?: string; recent?: boolean }) {
  return (
    <span className="flex min-w-0 w-full items-center gap-1.5">
      {/* The dock passes no label and keeps the whole path; the drawer's tree
          passes what its group header has not already said. */}
      <span className="min-w-0 flex-1 truncate text-left text-xs font-bold text-doom-hi">{label ?? item.relPath}</span>
      {recent ? (
        <span data-recent="true" title="most recent change" className="shrink-0 text-2xs text-doom-blue">
          ●
        </span>
      ) : null}
      {item.count > 1 ? <span className="shrink-0 text-2xs text-doom-faint">{item.count}×</span> : null}
      <span className={`shrink-0 text-2xs ${item.diffable ? 'text-doom-faint' : 'text-doom-yellow'}`}>
        {TOOL_LABEL[item.tool] ?? item.tool}
      </span>
    </span>
  );
}

export function FileActivityRow({ item, onOpen }: { item: FilesItemView; onOpen: () => void }) {
  return (
    <Button
      variant="ghost"
      size="card"
      data-testid={`activity-file-${item.relPath}`}
      data-file-diffable={item.diffable}
      title={item.diffable ? item.path : `${item.path} (changed by a command, so no diff was captured)`}
      onClick={onOpen}
      className="min-w-0 gap-0.5 rounded-md px-1 py-1 hover:bg-doom-panel"
    >
      <FileMetadata item={item} />
    </Button>
  );
}

/**
 * The directory a run of rows shares.
 *
 * Deliberately not an option: the cursor counts files, and a header is a label
 * rather than something to open. Keeping it out of the listbox is what lets
 * arrow keys and Enter stay exactly what they were before the tree existed.
 */
function FileGroupHeader({ prefix }: { prefix: string }) {
  return (
    <div
      data-testid={`files-browser-group-${prefix}`}
      className="truncate px-4 pt-2 pb-1 text-2xs font-bold tracking-wide text-doom-faint"
    >
      {prefix}
    </div>
  );
}

function BrowserFileRow({
  item,
  label,
  indented = false,
  recent = false,
  selected,
  onSelect,
  onOpen,
}: {
  item: FilesItemView;
  label: string;
  indented?: boolean;
  recent?: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-testid={`files-browser-file-${item.relPath}`}
      data-file-diffable={item.diffable}
      data-selected={selected}
      title={item.diffable ? item.path : `${item.path} (changed by a command, so no diff was captured)`}
      onMouseEnter={onSelect}
      onClick={onOpen}
      className={`flex min-w-0 cursor-pointer border-l-2 py-2 ${indented ? 'pr-4 pl-8' : 'px-4'} ${
        selected ? 'border-doom-blue bg-doom-panel' : 'border-transparent hover:bg-doom-panel/60'
      }`}
    >
      <FileMetadata item={item} label={label} recent={recent} />
    </div>
  );
}

/** The complete session file picker, ordered exactly as the file timeline supplies it. */
export function FilesBrowser({
  items,
  onClose,
  onOpen,
}: {
  items: readonly FilesItemView[];
  onClose: () => void;
  onOpen: (item: FilesItemView) => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = filterFileItems(items, query);
  // Grouping only earns its headers with the whole list in view. While a query
  // is active the reader is pinpointing one path, so the flat list answers that
  // better than a shape wrapped around two matches.
  const grouped = query.trim() === '' ? groupFileItems(shown) : undefined;
  // The order rows actually appear in, which is what the cursor counts through.
  const ordered = grouped === undefined ? shown : grouped.flatMap((group) => group.items);
  const positions = new Map(ordered.map((item, index) => [item.path, index]));
  const selected = ordered[selectedIndex];
  // The timeline hands the newest change first, so the head of the unfiltered
  // list is the one row worth marking once the tree has reordered by path.
  const recentPath = items[0]?.path;

  // A shrinking filter can strand the cursor past the end, so the clamp happens
  // while rendering the shorter list rather than in a pass after it paints.
  const [lastShownLength, setLastShownLength] = useState(shown.length);
  if (lastShownLength !== shown.length) {
    setLastShownLength(shown.length);
    setSelectedIndex((current) => Math.min(current, Math.max(0, shown.length - 1)));
  }

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const move = (delta: number): void => {
    if (ordered.length === 0) return;
    setSelectedIndex((current) => (current + delta + ordered.length) % ordered.length);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (
      event.key === 'Enter' &&
      selected !== undefined &&
      (!(event.target instanceof Element) || event.target.closest('button') === null)
    ) {
      event.preventDefault();
      onOpen(selected);
    }
  };

  return (
    <aside
      data-testid="files-browser"
      aria-label="changed files"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-y-0 right-0 z-50 flex w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden border-l border-doom-border bg-doom-rail outline-none"
    >
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-doom-border px-4">
        <span className="text-base font-bold text-doom-hi"># files</span>
        <span data-testid="files-browser-total" className="text-2xs text-doom-faint">
          {items.length} changed
        </span>
        <span className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          size="icon"
          data-testid="files-browser-close"
          aria-label="close changed files"
          title="close changed files"
          onClick={onClose}
        >
          <CloseIcon className="h-3 w-3" />
        </Button>
      </div>
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5">
        <Input
          ref={inputRef}
          data-testid="files-browser-search"
          aria-label="search changed file paths"
          value={query}
          placeholder="search paths…"
          autoFocus
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
        />
        {query.length > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            data-testid="files-browser-clear"
            aria-label="clear path search"
            onClick={() => {
              setQuery('');
              setSelectedIndex(0);
              inputRef.current?.focus();
            }}
          >
            clear
          </Button>
        ) : null}
      </div>
      <p data-testid="files-browser-matches" className="shrink-0 px-4 pb-2 text-2xs text-doom-faint">
        {shown.length} matches · {grouped === undefined ? 'newest change first' : 'by path'}
      </p>
      <div
        ref={listRef}
        role="listbox"
        aria-label="changed files"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2"
      >
        {shown.length === 0 ? <p className="px-4 py-3 text-xs text-doom-faint">nothing matches the path</p> : null}
        {grouped === undefined
          ? shown.map((item) => (
              <BrowserFileRow
                key={item.path}
                item={item}
                label={item.relPath}
                recent={item.path === recentPath}
                selected={positions.get(item.path) === selectedIndex}
                onSelect={() => setSelectedIndex(positions.get(item.path) ?? 0)}
                onOpen={() => onOpen(item)}
              />
            ))
          : grouped.map((group) => (
              <Fragment key={group.prefix}>
                {group.prefix === '' ? null : <FileGroupHeader prefix={group.prefix} />}
                {group.items.map((item) => (
                  <BrowserFileRow
                    key={item.path}
                    item={item}
                    label={groupRowLabel(group.prefix, item.relPath)}
                    indented
                    recent={item.path === recentPath}
                    selected={positions.get(item.path) === selectedIndex}
                    onSelect={() => setSelectedIndex(positions.get(item.path) ?? 0)}
                    onOpen={() => onOpen(item)}
                  />
                ))}
              </Fragment>
            ))}
      </div>
      <div className="flex h-8 shrink-0 items-center border-t border-doom-border-soft bg-doom-deep px-4">
        <span className="text-2xs text-doom-faint">↑↓ choose · enter open · esc close</span>
      </div>
    </aside>
  );
}
