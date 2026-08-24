import type { LeaderBindingContribution } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { type LeaderOption, leaderGroup } from '../../lib/leaderTree.ts';
import { paletteCommands, pluginLeaderBindings } from '../../lib/pluginRegistry.ts';
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
 * package has put on a key.
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
        setSearch('');
        setSelected(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The palette owns the keyboard while open: focus lands on the surface, not
  // the search box, so a typed letter is a leader key rather than filter text.
  useEffect(() => {
    if (open) surface.current?.focus();
  }, [open]);

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

  if (!open) return null;

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
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
      return;
    }
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
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!searching) {
        closePalette();
        return;
      }
      setSearch('');
      setSelected(0);
      surface.current?.focus();
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
    if (event.key === 'Enter' && currentMatch) {
      event.preventDefault();
      invoke(currentMatch.name);
    }
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-doom-deep/70 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
    >
      <div
        ref={surface}
        tabIndex={-1}
        data-testid="palette"
        data-path={path}
        onKeyDown={onSurfaceKey}
        className="flex w-[720px] flex-col overflow-hidden rounded-lg border border-doom-border bg-doom-panel shadow-2xl outline-none"
      >
        <div className="flex items-center gap-3 border-b border-doom-border px-4 py-3">
          <span className="rounded bg-doom-magenta/20 px-1.5 py-0.5 text-[9px] font-bold tracking-widest text-doom-magenta">
            {LEADER_PREFIX}
          </span>
          <span data-testid="palette-path" className="text-[12px] font-bold text-doom-hi">
            {keys.length === 0 ? 'Leader Space' : `${keys.join(' ')} · ${group?.label ?? ''}`}
          </span>
          <input
            ref={searchInput}
            data-testid="palette-filter"
            value={search}
            placeholder="/ search commands…"
            onChange={(event) => {
              setSearch(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onSearchKey}
            className="flex-1 bg-transparent text-right text-[12px] text-doom-hi outline-none placeholder:text-doom-faint"
          />
          <span data-testid="palette-count" className="text-[10px] text-doom-faint">
            {rowCount}
          </span>
        </div>

        <div className="flex min-h-[260px]">
          <div
            data-testid="palette-keys"
            className="w-[280px] shrink-0 overflow-y-auto border-r border-doom-border py-1"
          >
            {searching ? (
              matches.length === 0 ? (
                <p data-testid="palette-no-match" className="px-4 py-6 text-center text-[11px] text-doom-faint">
                  no command matches
                </p>
              ) : (
                matches.map((command, index) => (
                  <button
                    key={command.name}
                    type="button"
                    data-testid={`palette-sub-${command.name}`}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => invoke(command.name)}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                      index === cursor ? 'bg-doom-magenta/10' : ''
                    }`}
                  >
                    <span className="text-[11px] font-bold text-doom-blue">/{command.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-doom-faint">{command.description}</span>
                  </button>
                ))
              )
            ) : options.length === 0 ? (
              <p data-testid="palette-empty" className="px-4 py-6 text-center text-[11px] text-doom-faint">
                {keys.length === 0
                  ? 'no package in this bundle registered leader keys · / searches the session’s commands'
                  : 'nothing bound under this key'}
              </p>
            ) : (
              options.map((option, index) => (
                <button
                  key={option.key}
                  type="button"
                  data-testid={`palette-item-${index}`}
                  data-key={option.key}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => descend(option)}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                    index === cursor ? 'bg-doom-magenta/10' : ''
                  }`}
                >
                  <span
                    className={`w-5 rounded text-center text-[10px] font-bold ${
                      index === cursor ? 'bg-doom-magenta/25 text-doom-magenta' : 'bg-doom-deep text-doom-dim'
                    }`}
                  >
                    {option.key}
                  </span>
                  <span className="flex-1 truncate text-[11px] text-doom-text">{option.label}</span>
                  {option.binding ? null : (
                    <span className="text-[9px] text-doom-faint">
                      {option.children.length} {option.children.length === 1 ? 'key' : 'keys'}
                    </span>
                  )}
                </button>
              ))
            )}
            {pluginEntries.length > 0 ? (
              <>
                <p className="px-3 pb-1 pt-2 text-[8px] font-bold tracking-[0.14em] text-doom-faint">PLUGINS</p>
                {pluginEntries.map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    data-testid={`palette-plugin-${command.id}`}
                    onClick={() => runPluginCommand(command.id)}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-doom-magenta/10"
                  >
                    <span className="flex-1 truncate text-[11px] text-doom-text">{command.title}</span>
                    {command.description ? (
                      <span className="truncate text-[9px] text-doom-faint">{command.description}</span>
                    ) : null}
                  </button>
                ))}
              </>
            ) : null}
          </div>

          <div data-testid="palette-detail" className="flex min-w-0 flex-1 flex-col gap-2 px-4 py-3">
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
                      <button
                        key={child.key}
                        type="button"
                        data-testid={`palette-child-${child.key}`}
                        onClick={() => descend(child, [...keys, current.key])}
                        className="flex items-center gap-3 rounded border border-doom-border-soft bg-doom-deep px-3 py-1.5 text-left hover:border-doom-blue/50"
                      >
                        <span className="w-5 text-center text-[10px] font-bold text-doom-magenta">{child.key}</span>
                        <span className="text-[11px] font-bold text-doom-hi">{child.label}</span>
                        <span className="min-w-0 flex-1 truncate text-[10px] text-doom-faint">{child.detail}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-doom-border-soft bg-doom-deep px-4 py-2.5">
          <span className="text-[10px] text-doom-faint">
            {searching
              ? 'up/down move · enter run · esc back to keys'
              : 'keys walk · backspace up · enter select · / search · esc close'}
          </span>
          <span className="text-[10px] text-doom-dim">
            {bindings.length} keys · {commands.length} commands
          </span>
        </div>
      </div>
    </div>
  );
}
