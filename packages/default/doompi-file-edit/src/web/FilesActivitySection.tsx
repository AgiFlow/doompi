import { Button } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';
import type { FilesItemView } from '../types/webFiles.ts';
import { fileTab } from './FilePanel.tsx';
import { FileActivityRow, FilesBrowser } from './FilesBrowser.tsx';
import { files } from './filesStore.ts';

/**
 * The files group's body in the activity dock: what this session has changed.
 *
 * Every recorded file is listed, not only the ones the agent named. A file
 * found by comparing the tree around a bash call is marked, because it is
 * openable and editable but has no baseline to diff against, and a row that
 * hid that distinction would promise a diff the tab cannot show.
 */

/** The most recent changes first, which is the order the timeline already folds to. */
const VISIBLE_ROWS = 5;

export function FilesActivitySection({ sessionId, openTransientTab }: WebPluginSlotProps) {
  const { items } = useStore(files.store, (state) => files.select(state, sessionId));
  const [browserOpen, setBrowserOpen] = useState(false);

  const openFile = (item: FilesItemView): void => {
    if (sessionId === null) return;
    openTransientTab(fileTab(item.path, item.relPath));
    setBrowserOpen(false);
  };
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
        <FileActivityRow key={item.path} item={item} onOpen={() => openFile(item)} />
      ))}
      {items.length > visible.length ? (
        <Button
          variant="link"
          size="xs"
          data-testid="activity-files-show-all"
          aria-label={`show all ${items.length} changed files`}
          className="self-start px-1 pt-0.5 text-[9px] text-doom-faint"
          onClick={() => setBrowserOpen(true)}
        >
          show all {items.length} files
        </Button>
      ) : null}
      {browserOpen ? <FilesBrowser items={items} onClose={() => setBrowserOpen(false)} onOpen={openFile} /> : null}
    </div>
  );
}
