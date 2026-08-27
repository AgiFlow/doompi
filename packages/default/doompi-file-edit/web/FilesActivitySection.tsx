import { Button } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import type { FilesItemView } from '../src/types/webFiles.ts';
import { fileTab } from './FilePanel.tsx';
import { files } from './filesStore.ts';
import { TOOL_LABEL } from './fileView.ts';

/**
 * The files group's body in the activity dock: what this session has changed.
 *
 * Every recorded file is listed, not only the ones the agent named. A file
 * found by comparing the tree around a bash call is marked, because it is
 * openable and editable but has no baseline to diff against, and a row that
 * hid that distinction would promise a diff the tab cannot show.
 */

/** The most recent changes first, which is the order the timeline already folds to. */
const VISIBLE_ROWS = 12;

export function FilesActivitySection({ sessionId, openTransientTab }: WebPluginSlotProps) {
  const { items } = useStore(files.store, (state) => files.select(state, sessionId));

  if (items.length === 0) {
    return (
      <p data-testid="activity-summary-files" className="px-1 text-[10px] text-doom-faint">
        nothing changed yet
      </p>
    );
  }

  const visible = items.slice(0, VISIBLE_ROWS);

  return (
    <div data-testid="activity-file-edits" className="flex flex-col gap-0.5">
      {visible.map((item: FilesItemView) => (
        <Button
          key={item.path}
          variant="ghost"
          size="card"
          data-testid={`activity-file-${item.relPath}`}
          data-file-diffable={item.diffable}
          title={item.diffable ? item.path : `${item.path} (changed by a command, so no diff was captured)`}
          onClick={() => {
            if (sessionId === null) return;
            openTransientTab(fileTab(item.path, item.relPath));
          }}
          className="min-w-0 gap-0.5 rounded-[5px] px-1 py-1 hover:bg-doom-panel"
        >
          <span className="flex min-w-0 w-full items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-left text-[10px] font-bold text-doom-hi">{item.relPath}</span>
            {item.count > 1 ? <span className="shrink-0 text-[9px] text-doom-faint">{item.count}×</span> : null}
            <span className={`shrink-0 text-[9px] ${item.diffable ? 'text-doom-faint' : 'text-doom-yellow'}`}>
              {TOOL_LABEL[item.tool] ?? item.tool}
            </span>
          </span>
        </Button>
      ))}
      {items.length > visible.length ? (
        <p data-testid="activity-file-overflow" className="px-1 pt-0.5 text-[9px] text-doom-faint">
          and {items.length - visible.length} more
        </p>
      ) : null}
    </div>
  );
}
