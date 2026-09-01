import { Button, CloseIcon, Input } from '@agimon-ai/doompi-web-components';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { FilesItemView } from '../src/types/webFiles.ts';
import { filterFileItems, TOOL_LABEL } from './fileView.ts';

function FileMetadata({ item }: { item: FilesItemView }) {
  return (
    <span className="flex min-w-0 w-full items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-left text-[10px] font-bold text-doom-hi">{item.relPath}</span>
      {item.count > 1 ? <span className="shrink-0 text-[9px] text-doom-faint">{item.count}×</span> : null}
      <span className={`shrink-0 text-[9px] ${item.diffable ? 'text-doom-faint' : 'text-doom-yellow'}`}>
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
      className="min-w-0 gap-0.5 rounded-[5px] px-1 py-1 hover:bg-doom-panel"
    >
      <FileMetadata item={item} />
    </Button>
  );
}

function BrowserFileRow({
  item,
  selected,
  onSelect,
  onOpen,
}: {
  item: FilesItemView;
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
      className={`flex min-w-0 cursor-pointer border-l-2 px-4 py-2 ${
        selected ? 'border-doom-blue bg-doom-panel' : 'border-transparent hover:bg-doom-panel/60'
      }`}
    >
      <FileMetadata item={item} />
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
  const selected = shown[selectedIndex];

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
    if (shown.length === 0) return;
    setSelectedIndex((current) => (current + delta + shown.length) % shown.length);
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
        <span className="text-[13px] font-bold text-doom-hi"># files</span>
        <span data-testid="files-browser-total" className="text-[9px] text-doom-faint">
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
      <p data-testid="files-browser-matches" className="shrink-0 px-4 pb-2 text-[9px] text-doom-faint">
        {shown.length} matches · newest change first
      </p>
      <div
        ref={listRef}
        role="listbox"
        aria-label="changed files"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2"
      >
        {shown.length === 0 ? <p className="px-4 py-3 text-[10px] text-doom-faint">nothing matches the path</p> : null}
        {shown.map((item, index) => (
          <BrowserFileRow
            key={item.path}
            item={item}
            selected={index === selectedIndex}
            onSelect={() => setSelectedIndex(index)}
            onOpen={() => onOpen(item)}
          />
        ))}
      </div>
      <div className="flex h-8 shrink-0 items-center border-t border-doom-border-soft bg-doom-deep px-4">
        <span className="text-[9px] text-doom-faint">↑↓ choose · enter open · esc close</span>
      </div>
    </aside>
  );
}
