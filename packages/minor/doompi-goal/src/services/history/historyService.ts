import type { GoalHistoryEntry, GoalHistoryPort, HistoryRestart } from '../../types/history.ts';

export class GoalHistoryService implements GoalHistoryPort {
  constructor(private readonly store: Pick<GoalHistoryPort, 'list' | 'archive' | 'remove'>) {}

  list(): Promise<GoalHistoryEntry[]> {
    return this.store.list();
  }

  archive(entry: GoalHistoryEntry): Promise<GoalHistoryEntry> {
    return this.store.archive(entry);
  }

  remove(id: string): Promise<void> {
    return this.store.remove(id);
  }

  async restart(id: string): Promise<HistoryRestart> {
    const entry = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Goal history entry '${id}' was not found.`);
    return {
      historyId: entry.id,
      goalId: globalThis.crypto.randomUUID(),
      objective: entry.objective,
      ...(entry.budget === undefined ? {} : { budget: entry.budget }),
    };
  }
}
