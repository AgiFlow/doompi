import {
  cn,
  CommandEmpty,
  CommandFooter,
  CommandGroupLabel,
  CommandHeader,
  CommandInput,
  CommandItem,
  CommandItemLabel,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
  Kbd,
  OptionLabel,
  OptionRow,
  StatusBadge,
} from '@agimon-ai/doompi-web-components';
import type { LeaderBindingContribution } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { type LeaderOption, leaderGroup } from '../../lib/leaderTree.ts';
import { paletteCommands, pluginLeaderBindings } from '../../lib/pluginRegistry.ts';
import { focusPrompt } from '../../lib/promptFocus.ts';
import { sendFrame } from '../../lib/transport.ts';
import { useOpenTab } from '../../stores/useOpenTab.ts';
import { closePalette, paletteStore, setPalettePath, togglePalette } from '../../stores/paletteStore.ts';
import { runCommand, useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';

const LEADER_PREFIX = 'SPC';
const SEARCH_KEY = '/';
const LEADER_KEY = /^[a-z0-9]$/;

function pathLabel(keys: readonly string[]): string {
  return [LEADER_PREFIX, ...keys].join(' ');
}

/**
 * Leader Space, as much of it as a browser can honestly show.
 *
 * The session's own leader tree never reaches an RPC client, so the tree here
 * is what the installed web plugins declared: each package's cockpit half of
 * the key paths its TUI documents. Keys walk the tree the way the TUI does,
 * backspace climbs, and the slash search is the road to the commands no
 * package has put on a key. The surface is a modal dialog, so focus comes
 * back to wherever it was (usually the composer) when it closes.
 */
export function CommandPalette() {
  const commands = useActiveSession((state) => state.commands);
  const { open, path } = useStore(paletteStore);
  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const openTab = useOpenTab();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(0);
  const surface = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // ctrl+k is the browser-friendly binding; ctrl+space mirrors the TUI's
      // global leader key. Space in an empty composer opens it too.
      const leaderKey = event.key === 'k' || event.key === ' ';
      if (leaderKey && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Every opening starts at the root with an empty search. Adjusted during
  // render rather than in an effect so the palette never paints the previous
  // search for a frame.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setSearch('');
      setSelected(0);
    }
  }

  const keys = useMemo(() => path.split(''), [path]);
  const bindings = pluginLeaderBindings();
  const group = useMemo(() => leaderGroup(bindings, keys) ?? leaderGroup(bindings, []), [bindings, keys]);
  const options = group?.options ?? [];

  const needle = search.trim().toLowerCase();
  const searching = needle.length > 0;
  const matches = useMemo(
    () => (searching ? commands.filter((entry) => entry.name.toLowerCase().includes(needle)) : []),
    [commands, needle, searching],
  );
  const pluginEntries = keys.length === 0 && !searching ? paletteCommands() : [];

  const rowCount = searching ? matches.length : options.length;
  const cursor = Math.min(selected, Math.max(rowCount - 1, 0));
  const current = searching ? undefined : options[cursor];
  const currentMatch = searching ? matches[cursor] : undefined;

  const fire = (binding: LeaderBindingContribution): void => {
    closePalette();
    if ('command' in binding) {
      runCommand(binding.command);
      return;
    }
    binding.run({ sessionId: activeId, openTab, sendSessionFrame: sendFrame });
  };

  const descend = (option: LeaderOption, from: readonly string[] = keys): void => {
    if (option.binding) {
      fire(option.binding);
      return;
    }
    setPalettePath([...from, option.key].join(''));
    setSelected(0);
  };

  const climb = (): void => {
    if (keys.length === 0) {
      closePalette();
      return;
    }
    setPalettePath(keys.slice(0, -1).join(''));
    setSelected(0);
  };

  const invoke = (name: string): void => {
    closePalette();
    runCommand(name);
  };

  const runPluginCommand = (id: string): void => {
    const command = paletteCommands().find((candidate) => candidate.id === id);
    if (!command) return;
    closePalette();
    command.run({ sessionId: activeId, openTab, sendSessionFrame: sendFrame });
  };

  const onSurfaceKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // The search box handles its own keys; letters typed there are text.
    if (event.target === searchInput.current) return;
    if (event.key === 'Backspace') {
      event.preventDefault();
      climb();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected(Math.min(cursor + 1, Math.max(rowCount - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(Math.max(cursor - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (current) descend(current);
      return;
    }
    if (event.key === SEARCH_KEY) {
      event.preventDefault();
      searchInput.current?.focus();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (!LEADER_KEY.test(key)) return;
    const option = options.find((candidate) => candidate.key === key);
    if (!option) return;
    event.preventDefault();
    descend(option);
  };

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected(Math.min(cursor + 1, Math.max(rowCount - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(Math.max(cursor - 1, 0));
      return;
    }
    if (event.key === 'Enter' && currentMatch) {
      event.preventDefault();
      invoke(currentMatch.name);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette();
      }}
    >
      <DialogContent
        ref={surface}
        width="lg"
        data-testid="palette"
        data-path={path}
        aria-describedby={undefined}
        onKeyDown={onSurfaceKey}
        // The palette owns the keyboard: focus lands on the surface, not the
        // search box, so a typed letter is a leader key rather than filter text.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          surface.current?.focus();
        }}
        // Opened by a shortcut, so there is no trigger to restore focus to.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusPrompt();
        }}
        // Escape in a live search clears the search; only an empty one closes.
        onEscapeKeyDown={(event) => {
          if (searching && document.activeElement === searchInput.current) {
            event.preventDefault();
            setSearch('');
            setSelected(0);
            surface.current?.focus();
          }
        }}
        className="top-[12vh] w-[720px] max-w-[92vw] translate-y-0"
      >
        <DialogTitle className="sr-only">Leader Space</DialogTitle>
        <CommandHeader className="gap-3 px-4 py-3">
          <StatusBadge tone="accent" size="xs" className="tracking-widest">
            {LEADER_PREFIX}
          </StatusBadge>
          <span data-testid="palette-path" className="text-[12px] font-bold text-doom-hi">
            {keys.length === 0 ? 'Leader Space' : `${keys.join(' ')} · ${group?.label ?? ''}`}
          </span>
          <CommandInput
            ref={searchInput}
            data-testid="palette-filter"
            value={search}
            autoFocus={false}
            placeholder="/ search commands…"
            onChange={(event) => {
              setSearch(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onSearchKey}
            className="text-right"
          />
          <span data-testid="palette-count" className="text-[10px] text-doom-faint">
            {rowCount}
          </span>
        </CommandHeader>

        <div className="flex min-h-[260px] flex-col sm:flex-row">
          <CommandList
            data-testid="palette-keys"
            className="w-full shrink-0 gap-0 border-b border-doom-border p-1 sm:w-[280px] sm:border-r sm:border-b-0"
          >
            {searching ? (
              matches.length === 0 ? (
                <CommandEmpty data-testid="palette-no-match">no command matches</CommandEmpty>
              ) : (
                matches.map((command, index) => (
                  <CommandItem
                    key={command.name}
                    data-testid={`palette-sub-${command.name}`}
                    active={index === cursor}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => invoke(command.name)}
                    className={cn('w-full gap-2.5 px-3 py-1.5', index === cursor && 'bg-doom-magenta/10')}
                  >
                    <span className="text-[11px] font-bold text-doom-blue">/{command.name}</span>
                    <CommandItemLabel className="text-[10px] text-doom-faint">{command.description}</CommandItemLabel>
                  </CommandItem>
                ))
              )
            ) : options.length === 0 ? (
              <CommandEmpty data-testid="palette-empty">
                {keys.length === 0
                  ? 'no package in this bundle registered leader keys · / searches the session’s commands'
                  : 'nothing bound under this key'}
              </CommandEmpty>
            ) : (
              options.map((option, index) => (
                <CommandItem
                  key={option.key}
                  data-testid={`palette-item-${index}`}
                  data-key={option.key}
                  active={index === cursor}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => descend(option)}
                  className={cn('w-full gap-2.5 px-3 py-1.5', index === cursor && 'bg-doom-magenta/10')}
                >
                  <Kbd
                    className={cn(
                      'w-5 text-center',
                      index === cursor ? 'bg-doom-magenta/25 text-doom-magenta' : 'bg-doom-deep text-doom-dim',
                    )}
                  >
                    {option.key}
                  </Kbd>
                  <CommandItemLabel className="text-[11px] text-doom-text">{option.label}</CommandItemLabel>
                  {option.binding ? null : (
                    <span className="text-[9px] text-doom-faint">
                      {option.children.length} {option.children.length === 1 ? 'key' : 'keys'}
                    </span>
                  )}
                </CommandItem>
              ))
            )}
            {pluginEntries.length > 0 ? (
              <>
                <CommandGroupLabel>plugins</CommandGroupLabel>
                {pluginEntries.map((command) => (
                  <CommandItem
                    key={command.id}
                    data-testid={`palette-plugin-${command.id}`}
                    onClick={() => runPluginCommand(command.id)}
                    className="w-full gap-2.5 px-3 py-1.5 hover:bg-doom-magenta/10"
                  >
                    <CommandItemLabel className="text-[11px] text-doom-text">{command.title}</CommandItemLabel>
                    {command.description ? (
                      <span className="truncate text-[9px] text-doom-faint">{command.description}</span>
                    ) : null}
                  </CommandItem>
                ))}
              </>
            ) : null}
          </CommandList>

          <div data-testid="palette-detail" className="hidden min-w-0 flex-1 flex-col gap-2 px-4 py-3 sm:flex">
            {currentMatch ? (
              <>
                <span className="text-[12px] font-bold text-doom-blue">/{currentMatch.name}</span>
                <span className="text-[11px] text-doom-faint">{currentMatch.description}</span>
              </>
            ) : null}
            {current ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-bold text-doom-magenta">{pathLabel([...keys, current.key])}</span>
                  <span className="text-[12px] text-doom-hi">{current.label}</span>
                </div>
                {current.detail ? <span className="text-[10px] text-doom-faint">{current.detail}</span> : null}
                {current.binding ? (
                  <span data-testid="palette-target" className="text-[11px] font-bold text-doom-blue">
                    {'command' in current.binding ? `/${current.binding.command}` : 'in the cockpit'}
                  </span>
                ) : (
                  <div className="flex flex-col gap-1">
                    {current.children.map((child) => (
                      <OptionRow
                        key={child.key}
                        data-testid={`palette-child-${child.key}`}
                        onClick={() => descend(child, [...keys, current.key])}
                        className="min-h-0 gap-3 border-doom-border-soft bg-doom-deep px-3 py-1.5 hover:border-doom-blue/50"
                      >
                        <span className="w-5 text-center text-[10px] font-bold text-doom-magenta">{child.key}</span>
                        <span className="text-[11px] font-bold text-doom-hi">{child.label}</span>
                        <OptionLabel className="truncate text-[10px] text-doom-faint">{child.detail}</OptionLabel>
                      </OptionRow>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>

        <CommandFooter className="px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-[10px] text-doom-faint">
            {searching ? (
              <>
                <Kbd>↑↓</Kbd> move · <Kbd>enter</Kbd> run · <Kbd>esc</Kbd> back to keys
              </>
            ) : (
              <>
                keys walk · <Kbd>⌫</Kbd> up · <Kbd>enter</Kbd> select · <Kbd>/</Kbd> search · <Kbd>esc</Kbd> close
              </>
            )}
          </span>
          <span className="text-[10px] text-doom-dim">
            {bindings.length} keys · {commands.length} commands
          </span>
        </CommandFooter>
      </DialogContent>
    </Dialog>
  );
}
