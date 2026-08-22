import type {
  DoomContextContribution,
  DoomContextContributionEntry,
  DoomContextContributionError,
  DoomContextContributionRegistration,
  DoomContextContributionsService,
  DoomContextContributionsSnapshot,
} from '../schemas/contextContributions.ts';

interface StoredContribution extends DoomContextContribution {
  readonly key: string;
}

function compareContributions(left: DoomContextContribution, right: DoomContextContribution): number {
  const sourceOrder = left.source < right.source ? -1 : left.source > right.source ? 1 : 0;
  const idOrder = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return left.order - right.order || sourceOrder || idOrder;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`Doom context contribution ${field} must not be empty.`);
}

function contributionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Creates the host-owned aggregation service for one Doom session generation. */
export function createDoomContextContributionsService(generation: string): DoomContextContributionsService {
  if (!generation) throw new Error('Doom context contributions require a session generation.');

  const contributions = new Map<string, StoredContribution>();
  return Object.freeze({
    generation,
    register(contribution: DoomContextContribution): DoomContextContributionRegistration {
      assertNonEmpty(contribution.source, 'source');
      assertNonEmpty(contribution.id, 'id');
      assertNonEmpty(contribution.label, 'label');
      if (!Number.isFinite(contribution.order)) {
        throw new Error('Doom context contribution order must be a finite number.');
      }
      if (typeof contribution.snapshot !== 'function') {
        throw new Error('Doom context contribution snapshot must be a function.');
      }

      const key = JSON.stringify([contribution.source, contribution.id]);
      if (contributions.has(key)) {
        throw new Error(`Doom context contribution is already registered: ${contribution.source}/${contribution.id}.`);
      }
      const stored: StoredContribution = Object.freeze({
        key,
        source: contribution.source,
        id: contribution.id,
        label: contribution.label,
        order: contribution.order,
        snapshot: () => contribution.snapshot(),
      });
      contributions.set(key, stored);

      let disposed = false;
      return Object.freeze({
        dispose(): void {
          if (disposed) return;
          disposed = true;
          if (contributions.get(key) === stored) contributions.delete(key);
        },
      });
    },
    snapshot(): DoomContextContributionsSnapshot {
      const entries: DoomContextContributionEntry[] = [];
      const errors: DoomContextContributionError[] = [];
      const ordered = [...contributions.values()].sort(compareContributions);

      for (const contribution of ordered) {
        const identity = {
          source: contribution.source,
          id: contribution.id,
          label: contribution.label,
          order: contribution.order,
        };
        try {
          const text = contribution.snapshot();
          if (text === undefined) continue;
          if (typeof text !== 'string') throw new Error('Snapshot returned a non-string value.');
          entries.push(Object.freeze({ ...identity, text }));
        } catch (error) {
          errors.push(Object.freeze({ ...identity, message: contributionErrorMessage(error) }));
        }
      }

      return Object.freeze({ entries: Object.freeze(entries), errors: Object.freeze(errors) });
    },
  });
}
