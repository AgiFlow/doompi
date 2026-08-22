import type {
  DoomToolOverrideClaim,
  DoomToolOverrideRegistration,
  DoomToolOverridesService,
} from '../schemas/toolOverrides.ts';

interface StoredClaim {
  readonly source: string;
  readonly tools: readonly string[];
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`Doom tool override ${field} must not be empty.`);
}

/** Creates the host-owned tool replacement registry for one Doom runtime. */
export function createDoomToolOverridesService(generation: string): DoomToolOverridesService {
  if (!generation) throw new Error('Doom tool overrides require a runtime generation.');

  const owners = new Map<string, StoredClaim>();
  return Object.freeze({
    generation,
    claim(claim: DoomToolOverrideClaim): DoomToolOverrideRegistration {
      assertNonEmpty(claim.source, 'source');
      if (claim.tools.length === 0) throw new Error('Doom tool override tools must not be empty.');
      for (const tool of claim.tools) assertNonEmpty(tool, 'tool');

      const tools = Object.freeze([...new Set(claim.tools)]);
      if (tools.some((tool) => owners.has(tool))) {
        return Object.freeze({ granted: false, tools, dispose: (): void => undefined });
      }

      const stored: StoredClaim = Object.freeze({ source: claim.source, tools });
      for (const tool of tools) owners.set(tool, stored);

      let disposed = false;
      return Object.freeze({
        granted: true,
        tools,
        dispose(): void {
          if (disposed) return;
          disposed = true;
          for (const tool of tools) {
            if (owners.get(tool) === stored) owners.delete(tool);
          }
        },
      });
    },
    owner(tool: string): string | undefined {
      return owners.get(tool)?.source;
    },
  });
}
