import { Store } from '@tanstack/store';

import type { WorkspaceSummary } from '../../types/hub';

export interface WorkspacesState {
  order: string[];
  byId: Record<string, WorkspaceSummary>;
  selectedId: string | null;
  hydrated: boolean;
}

const initialState: WorkspacesState = { order: [], byId: {}, selectedId: null, hydrated: false };

export const workspacesStore = new Store<WorkspacesState>(initialState);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asWorkspace(value: unknown): WorkspaceSummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.root !== 'string') return undefined;
  return {
    id: value.id,
    root: value.root,
    ...(typeof value.available === 'boolean' ? { available: value.available } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

export function applyWorkspacesSnapshot(frame: Record<string, unknown>): void {
  if (!Array.isArray(frame.workspaces)) return;
  const workspaces = frame.workspaces
    .map(asWorkspace)
    .filter((entry): entry is WorkspaceSummary => entry !== undefined);
  workspacesStore.setState((state) => {
    const byId = Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace]));
    const selectedId =
      state.selectedId !== null && byId[state.selectedId] !== undefined
        ? state.selectedId
        : (workspaces[0]?.id ?? null);
    return { order: workspaces.map((workspace) => workspace.id), byId, selectedId, hydrated: true };
  });
}

export function applyWorkspaceUpsert(frame: Record<string, unknown>): void {
  const workspace = asWorkspace(frame.workspace);
  if (workspace === undefined) return;
  workspacesStore.setState((state) => ({
    ...state,
    order: state.byId[workspace.id] === undefined ? [...state.order, workspace.id] : state.order,
    byId: { ...state.byId, [workspace.id]: workspace },
    selectedId: state.selectedId ?? workspace.id,
    hydrated: true,
  }));
}

export function applyWorkspaceRemoved(frame: Record<string, unknown>): void {
  if (typeof frame.workspaceId !== 'string') return;
  const workspaceId = frame.workspaceId;
  workspacesStore.setState((state) => {
    if (state.byId[workspaceId] === undefined) return state;
    const byId = { ...state.byId };
    delete byId[workspaceId];
    return {
      ...state,
      order: state.order.filter((id) => id !== workspaceId),
      byId,
      selectedId: state.selectedId === workspaceId ? null : state.selectedId,
    };
  });
}

export function selectWorkspace(workspaceId: string | null): void {
  workspacesStore.setState((state) =>
    state.selectedId === workspaceId ? state : { ...state, selectedId: workspaceId },
  );
}

export function resetWorkspaces(): void {
  workspacesStore.setState(() => initialState);
}
