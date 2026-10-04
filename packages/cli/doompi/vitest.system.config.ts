import { defineConfig } from 'vitest/config';

const systemShard = process.env.DOOMPI_SYSTEM_SHARD;
// Successful run 37062958068 measured lanes 1/3 at 484s/499s and
// lanes 2/4/5/6 at 43s/42s/134s/72s. Move existing independent cold
// cases to the light lanes, without duplicating their builds or fixtures.
// Full test paths use the same boundary matching as whole-suite assignments.
const groupedSuites = {
  '1': [
    'DPI installed experiment runtime > keeps packed repository versions, registrations, assets, APIs, and raw Pi startup isolated',
  ],
  '2': [
    'DOOM-PI-LAUNCH installed runtime modes',
    'DPI installed experiment runtime > initializes, syncs, and launches without persisting its managed settings',
  ],
  '3': [
    'RPC-LIFECYCLE installed runtime > compiles packed authoring modules without evaluating them during sync',
    'RPC-LIFECYCLE installed runtime > loads the synced packed package from user settings without an explicit build',
    'RPC-LIFECYCLE installed runtime > injects an installed Cordis UI contribution and terminates the wrapped Pi child',
  ],
  '4': [
    'packed package identity and closure',
    'conventional Pi discovery',
    'RPC-LIFECYCLE installed runtime > lets a project DoomPi registration win over a simultaneous user registration',
  ],
  '5': ['consumer ownership boundaries', 'resources, RMUX, and installed text rendering'],
  '6': [
    'hub hook generation admission',
    'system target and CI gate',
    'packed system command timing',
    'frozen published package compatibility baseline',
    'a composed session against a scripted model',
    'packed startup input readiness',
    'measures direct entries and the synced Doom wrapper before accepting input',
    'RPC-LIFECYCLE installed runtime > acknowledges real task delegation from a synced plain Pi session with agents enabled',
  ],
} as const;

type SystemShard = keyof typeof groupedSuites;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function systemTestNamePattern(): RegExp | undefined {
  if (systemShard === undefined) return undefined;
  if (!(systemShard in groupedSuites)) {
    throw new Error('DOOMPI_SYSTEM_SHARD must be 1, 2, 3, 4, 5, or 6');
  }

  const suites = groupedSuites[systemShard as SystemShard];
  const suiteBoundary = `(?:${suites.map(escapeRegExp).join('|')})(?: > |$)`;
  return new RegExp(`^${suiteBoundary}`);
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/system/**/*.system.test.ts'],
    exclude: ['node_modules/**/*', 'dist/**/*', 'coverage/**/*'],
    testNamePattern: systemTestNamePattern(),
    // One file at a time. These suites pack, install, and launch real
    // processes, so running two of them at once turns a turn that takes
    // seconds into one that outlasts its budget on a busy machine.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    coverage: { enabled: false },
  },
});
