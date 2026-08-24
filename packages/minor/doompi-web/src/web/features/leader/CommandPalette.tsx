import { useNavigate } from '@tanstack/react-router';
import { useStore } from '@tanstack/react-store';
import { useEffect, useMemo, useState } from 'react';
import { minorModes } from '../../lib/composition.ts';
import { paletteCommands } from '../../lib/pluginRegistry.ts';
import { sendFrame } from '../../lib/transport.ts';
import { closePalette, paletteStore, togglePalette } from '../../stores/paletteStore.ts';
import { runCommand, useActiveSession } from '../../stores/sessionStore.ts';
import { sessionsStore } from '../../stores/sessionsStore.ts';

interface Group {
  key: string;
  label: string;
  tag: string;
  active: boolean;
  commands: { name: string; description: string }[];
}

/**
 * Leader Space, as much of it as a browser can honestly show.
 *
 * The TUI's key paths are a fixed prefix map, but which of them exist depends
 * on the composition, so groups are built from the commands the session
 * actually reported through get_commands rather than from a hard-coded tree.
 */
function groupCommands(
  commands: readonly { name: string; description: string }[],
  activeModes: ReadonlySet<string>,
): Group[] {
  const groups = new Map<string, Group>();
  for (const command of commands) {
    const key = command.name.charAt(0);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.commands.push(command);
      continue;
    }
    groups.set(key, {
      key,
      label: command.name,
      tag: '',
      active: activeModes.has(command.name),
      commands: [command],
    });
  }
  for (const group of groups.values()) {
    group.commands.sort((left, right) => left.name.localeCompare(right.name));
    group.label = group.commands[0].name;
    group.tag = group.commands.length > 1 ? `${group.commands.length} commands` : '';
    group.active = group.commands.some((command) => activeModes.has(command.name));
  }
  return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function CommandPalette() {
  const commands = useActiveSession((state) => state.commands);
  const statuses = useActiveSession((state) => state.statuses);
  const widgets = useActiveSession((state) => state.widgets);
  const { open } = useStore(paletteStore);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // ctrl+k is the browser-friendly binding; ctrl+space mirrors the
      // composer's "^SPC leader" hint.
      const leaderKey = event.key === 'k' || event.key === ' ';
      if (leaderKey && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        togglePalette();
        setFilter('');
        setSelected(0);
      }
      if (event.key === 'Escape') closePalette();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const activeModes = useMemo(
    () =>
      new Set(
        minorModes(statuses, widgets)
          .filter((mode) => mode.availability === 'on')
          .map((mode) => mode.name),
      ),
    [statuses, widgets],
  );

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const pool = needle ? commands.filter((entry) => entry.name.toLowerCase().includes(needle)) : commands;
    return groupCommands(pool, activeModes);
  }, [commands, filter, activeModes]);

  const activeId = useStore(sessionsStore, (state) => state.activeId);
  const navigate = useNavigate();
  const pluginEntries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const pool = paletteCommands();
    return needle ? pool.filter((command) => command.title.toLowerCase().includes(needle)) : pool;
  }, [filter]);
  const runPluginCommand = (id: string): void => {
    const command = paletteCommands().find((candidate) => candidate.id === id);
    if (!command) return;
    closePalette();
    command.run({
      sessionId: activeId,
      openTab: (tabId) => {
        if (activeId === null) return;
        void (tabId === null
          ? navigate({ to: '/session/$sessionId', params: { sessionId: activeId } })
          : navigate({ to: '/session/$sessionId/$tabId', params: { sessionId: activeId, tabId } }));
      },
      sendSessionFrame: sendFrame,
    });
  };

  const current = groups[Math.min(selected, Math.max(groups.length - 1, 0))];

  if (!open) return null;

  const invoke = (name: string): void => {
    runCommand(name);
    closePalette();
  };

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center bg-doom-deep/70 pt-[12vh]">
      <div
        data-testid="palette"
        className="flex w-[720px] flex-col overflow-hidden rounded-lg border border-doom-border bg-doom-panel shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-doom-border px-4 py-3">
          <span className="rounded bg-doom-magenta/20 px-1.5 py-0.5 text-[9px] font-bold tracking-widest text-doom-magenta">
            SPC
          </span>
          <span className="text-[12px] font-bold text-doom-hi">Leader Space</span>
          <input
            autoFocus
            data-testid="palette-filter"
            value={filter}
            placeholder="filter…"
            onChange={(event) => {
              setFilter(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') setSelected((index) => Math.min(index + 1, groups.length - 1));
              if (event.key === 'ArrowUp') setSelected((index) => Math.max(index - 1, 0));
              if (event.key === 'Enter' && current) invoke(current.commands[0].name);
            }}
            className="flex-1 bg-transparent text-[12px] text-doom-hi outline-none placeholder:text-doom-faint"
          />
          <span data-testid="palette-count" className="text-[10px] text-doom-faint">
            {groups.length}
          </span>
        </div>

        <div className="flex min-h-[260px]">
          <div
            data-testid="palette-keys"
            className="w-[280px] shrink-0 overflow-y-auto border-r border-doom-border py-1"
          >
            {groups.length === 0 ? (
              <p data-testid="palette-empty" className="px-4 py-6 text-center text-[11px] text-doom-faint">
                this session reported no commands
              </p>
            ) : (
              groups.map((group, index) => (
                <button
                  key={group.key}
                  type="button"
                  data-testid={`palette-item-${index}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => invoke(group.commands[0].name)}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                    index === selected ? 'bg-doom-magenta/10' : ''
                  }`}
                >
                  <span
                    className={`w-5 rounded text-center text-[10px] font-bold ${
                      index === selected ? 'bg-doom-magenta/25 text-doom-magenta' : 'bg-doom-deep text-doom-dim'
                    }`}
                  >
                    {group.key}
                  </span>
                  <span className="flex-1 truncate text-[11px] text-doom-text">{group.label}</span>
                  {group.active ? <span className="text-[8px] font-bold text-doom-magenta">on</span> : null}
                  {group.tag ? <span className="text-[9px] text-doom-faint">{group.tag}</span> : null}
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
            {current ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-bold text-doom-magenta">SPC {current.key}</span>
                  <span className="text-[12px] text-doom-hi">{current.label}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {current.commands.map((command) => (
                    <button
                      key={command.name}
                      type="button"
                      data-testid={`palette-sub-${command.name}`}
                      onClick={() => invoke(command.name)}
                      className="flex items-center gap-3 rounded border border-doom-border-soft bg-doom-deep px-3 py-1.5 text-left hover:border-doom-blue/50"
                    >
                      <span className="text-[11px] font-bold text-doom-blue">/{command.name}</span>
                      <span className="min-w-0 flex-1 truncate text-[10px] text-doom-faint">{command.description}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-doom-border-soft bg-doom-deep px-4 py-2.5">
          <span className="text-[10px] text-doom-faint">up/down move · enter select · esc close</span>
          <span className="text-[10px] text-doom-dim">{commands.length} commands</span>
        </div>
      </div>
    </div>
  );
}
