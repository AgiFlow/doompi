import { Store } from '@tanstack/store';
import type { WorktreeRecord } from '../../types/worktreeRegistry.ts';

const API_BASE = '/api/plugin/git';

/**
 * The host's transport, not the global fetch.
 *
 * A cockpit reached through the remote tunnel routes package API calls through
 * a sealed transport; calling `fetch` directly works locally and then fails for
 * exactly the users who are hardest to debug for.
 */
export type HostRequest = (input: string, init?: RequestInit) => Promise<Response>;

export interface WorktreesState {
  /** Keyed by repository, because the panel follows the focused session. */
  byRepository: Record<string, readonly WorktreeRecord[]>;
  loading: boolean;
  /** The last failure, shown in place of a silent empty list. */
  error: string | undefined;
  busy: boolean;
}

export const worktreesStore = new Store<WorktreesState>({
  byRepository: {},
  loading: false,
  error: undefined,
  busy: false,
});

export function selectWorktrees(state: WorktreesState, repositoryId: string | null): readonly WorktreeRecord[] {
  return repositoryId === null ? [] : (state.byRepository[repositoryId] ?? []);
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${String(response.status)}).`;
}

/** Loads the worktrees for a repository, replacing whatever was shown. */
export async function loadWorktrees(request: HostRequest, repositoryId: string): Promise<void> {
  worktreesStore.setState((state) => ({ ...state, loading: true, error: undefined }));
  try {
    const response = await request(`${API_BASE}/worktrees?repositoryId=${encodeURIComponent(repositoryId)}`);
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { worktrees: WorktreeRecord[] };
    worktreesStore.setState((state) => ({
      ...state,
      loading: false,
      byRepository: { ...state.byRepository, [repositoryId]: body.worktrees },
    }));
  } catch (error) {
    worktreesStore.setState((state) => ({ ...state, loading: false, error: (error as Error).message }));
  }
}

export interface CreateWorktreeInput {
  repositoryId: string;
  branch: string;
  baseRef?: string;
  name?: string;
}

/**
 * Creates a worktree and its session through the hub.
 *
 * The same route the `run_worktree` tool calls. One path for both so the panel
 * and the agent cannot drift into two different ideas of what creating a
 * worktree means.
 */
export async function createWorktree(request: HostRequest, input: CreateWorktreeInput): Promise<boolean> {
  worktreesStore.setState((state) => ({ ...state, busy: true, error: undefined }));
  try {
    const response = await request(`${API_BASE}/worktrees?repositoryId=${encodeURIComponent(input.repositoryId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        branch: input.branch,
        ...(input.baseRef === undefined || input.baseRef === '' ? {} : { baseRef: input.baseRef }),
        ...(input.name === undefined || input.name === '' ? {} : { name: input.name }),
      }),
    });
    if (!response.ok) throw new Error(await readError(response));
    await loadWorktrees(request, input.repositoryId);
    worktreesStore.setState((state) => ({ ...state, busy: false }));
    return true;
  } catch (error) {
    worktreesStore.setState((state) => ({ ...state, busy: false, error: (error as Error).message }));
    return false;
  }
}

/** Closes a worktree. `force` discards uncommitted work and is never implicit. */
export async function closeWorktree(
  request: HostRequest,
  repositoryId: string,
  id: string,
  force: boolean,
): Promise<boolean> {
  worktreesStore.setState((state) => ({ ...state, busy: true, error: undefined }));
  try {
    const query = new URLSearchParams({ repositoryId, ...(force ? { force: 'true' } : {}) });
    const response = await request(`${API_BASE}/worktrees/${encodeURIComponent(id)}?${query.toString()}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(await readError(response));
    await loadWorktrees(request, repositoryId);
    worktreesStore.setState((state) => ({ ...state, busy: false }));
    return true;
  } catch (error) {
    worktreesStore.setState((state) => ({ ...state, busy: false, error: (error as Error).message }));
    return false;
  }
}
