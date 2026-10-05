import {
  Button,
  CheckIcon,
  ChevronDownIcon,
  CommandEmpty,
  CommandHeader,
  CommandInput,
  CommandItem,
  CommandList,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@agimon-ai/doompi-web-components';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { matchesQuery } from '../_lib/styleSystemBrowser';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Dim second line, such as a path or a count. */
  detail?: string;
  /** Tree indent, dropped while a query flattens the list. */
  depth?: number;
  /** The label once the tree is flattened by a query, and on the trigger; defaults to label. */
  fullLabel?: string;
  /** What a query matches; defaults to the full label. */
  keywords?: string;
}

interface ComboboxProps {
  label: string;
  placeholder: string;
  options: readonly ComboboxOption[];
  selected: readonly string[];
  onSelect: (value: string) => void;
  /** Keep the list open after a pick, for toggling several values. */
  multiple?: boolean;
  defaultOpen?: boolean;
  className?: string;
}

const indents = ['pl-2', 'pl-5', 'pl-8', 'pl-11', 'pl-14'];

/** A trigger that opens a searchable option list: the search narrows the list, a pick reports one value. */
export function Combobox({
  label,
  placeholder,
  options,
  selected,
  onSelect,
  multiple,
  defaultOpen = false,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const flat = query.trim() !== '';
  const visible = flat
    ? options.filter((entry) => matchesQuery(entry.keywords ?? entry.fullLabel ?? entry.label, query))
    : options;
  const chosen = options.filter((entry) => entry.value !== '' && selected.includes(entry.value));
  useEffect(() => {
    list.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const toggle = (next: boolean): void => {
    setOpen(next);
    setQuery('');
    setCursor(
      Math.max(
        0,
        options.findIndex((entry) => selected.includes(entry.value)),
      ),
    );
  };
  const pick = (value: string): void => {
    onSelect(value);
    if (!multiple) toggle(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visible.length > 0)
        setCursor((cursor + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
    } else if (event.key === 'Enter') {
      const option = visible[cursor];
      if (option === undefined) return;
      event.preventDefault();
      pick(option.value);
    }
  };

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <Button
          role="combobox"
          aria-label={label}
          size="sm"
          variant="outline"
          className={cn('min-w-0 justify-between', className)}
        >
          <span className={cn('truncate', chosen.length === 0 && 'text-doom-faint')}>
            {chosen.length === 0 ? placeholder : chosen.map((entry) => entry.fullLabel ?? entry.label).join(', ')}
          </span>
          <ChevronDownIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-[60vh] w-(--radix-popover-trigger-width) min-w-72">
        <CommandHeader>
          <CommandInput
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder="Search..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
        </CommandHeader>
        <CommandList ref={list} aria-label={label} aria-multiselectable={multiple}>
          {visible.length === 0 ? <CommandEmpty>No matches.</CommandEmpty> : null}
          {visible.map((entry, index) => (
            <CommandItem
              key={entry.value}
              active={index === cursor}
              title={entry.fullLabel ?? entry.label}
              className={flat ? undefined : indents[Math.min(entry.depth ?? 0, indents.length - 1)]}
              onMouseEnter={() => setCursor(index)}
              onClick={() => pick(entry.value)}
            >
              <CheckIcon
                className={cn('size-3.5 shrink-0 text-doom-blue', !selected.includes(entry.value) && 'invisible')}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-doom-text">
                  {flat ? (entry.fullLabel ?? entry.label) : entry.label}
                </span>
                {entry.detail === undefined ? null : (
                  <span className="block truncate text-xs text-doom-dim">{entry.detail}</span>
                )}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </PopoverContent>
    </Popover>
  );
}
