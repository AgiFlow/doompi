import type { LeaderTone } from '@agimon-ai/doompi-extension-contracts/leader';
import type { MinorModeRecord, ModeTextColor } from '@agimon-ai/doompi-extension-contracts/mode';

export interface LeaderOption {
  key: string;
  label: string;
  detail?: string;
  tone?: LeaderTone;
}

export interface LeaderSnapshot {
  active: boolean;
  prefix: string[];
  label: string;
  options: LeaderOption[];
  rootOptions?: LeaderOption[];
}

export interface UiMinorModeStatus {
  source: string;
  id: string;
  label: string;
  detail?: string;
  color?: ModeTextColor;
  order: number;
}

type StateListener = (snapshot: LeaderSnapshot) => void;

const INACTIVE_SNAPSHOT: LeaderSnapshot = {
  active: false,
  prefix: [],
  label: '',
  options: [],
};

function cloneSnapshot(snapshot: LeaderSnapshot): LeaderSnapshot {
  return {
    active: snapshot.active,
    prefix: [...snapshot.prefix],
    label: snapshot.label,
    options: snapshot.options.map((option) => ({ ...option })),
    ...(snapshot.rootOptions ? { rootOptions: snapshot.rootOptions.map((option) => ({ ...option })) } : {}),
  };
}

export function projectMinorModeRecords(records: readonly MinorModeRecord[]): UiMinorModeStatus[] {
  return records
    .filter(({ state }) => state.activation !== 'inactive')
    .map(({ descriptor, state }) => ({
      source: descriptor.source,
      id: descriptor.id,
      label: descriptor.label,
      order: descriptor.order,
      ...(state.detail ? { detail: state.detail } : {}),
      ...(state.color ? { color: state.color } : {}),
    }))
    .sort(
      (left, right) =>
        left.order - right.order || left.source.localeCompare(right.source) || left.id.localeCompare(right.id),
    );
}

export class DoomUiState {
  private snapshot = INACTIVE_SNAPSHOT;
  private modes: readonly UiMinorModeStatus[] = [];
  private readonly listeners = new Set<StateListener>();

  getSnapshot(): LeaderSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  getModes(): readonly UiMinorModeStatus[] {
    return this.modes;
  }

  setModes(modes: readonly UiMinorModeStatus[]): void {
    this.modes = modes.map((mode) => ({ ...mode }));
    for (const listener of this.listeners) listener(this.getSnapshot());
  }

  setLeader(snapshot: LeaderSnapshot): void {
    this.snapshot = cloneSnapshot(snapshot);
    for (const listener of this.listeners) listener(this.getSnapshot());
  }

  reset(): void {
    this.modes = [];
    this.setLeader(INACTIVE_SNAPSHOT);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
