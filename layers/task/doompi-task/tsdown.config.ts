import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

/**
 * Host entries come from the folder tree. Public subpaths retain the historic
 * names and emitted filenames that external consumers already use.
 */
const routed = doompiExtension({
  packageDir: process.cwd(),
  pluginId: 'task',
  exportsDir: 'src/exports/_none',
  entry: {
    'api-contracts': 'src/exports/apiContracts.ts',
    'store-process-liveness': 'src/exports/storeProcessLiveness.ts',
    'delegation-manager': 'src/exports/delegationManager.ts',
    logSinkTelemetry: 'src/exports/logSinkTelemetry.ts',
    commands: 'src/exports/commands.ts',
    'store-invariants': 'src/exports/storeInvariants.ts',
    'store-task-graph': 'src/exports/storeTaskGraph.ts',
    'tool-response-envelope': 'src/exports/toolResponseEnvelope.ts',
    'tui-task-overlay': 'src/exports/tuiTaskOverlay.ts',
    'store-reconcile': 'src/exports/storeReconcile.ts',
    'tui-selectors': 'src/exports/tuiSelectors.ts',
    'tool-prompt-guidelines': 'src/exports/toolPromptGuidelines.ts',
    'store-task-store': 'src/exports/storeTaskStore.ts',
    'tui-format': 'src/exports/tuiFormat.ts',
    'tui-task-space': 'src/exports/tuiTaskSpace.ts',
    'store-reducer': 'src/exports/storeReducer.ts',
    'store-paths': 'src/exports/storePaths.ts',
    'tool-schema': 'src/exports/toolSchema.ts',
    index: 'src/exports/index.ts',
    'store-types': 'src/exports/storeTypes.ts',
    config: 'src/exports/config.ts',
    'tool-task-tool': 'src/exports/toolTaskTool.ts',
  },
});
if (!Array.isArray(routed)) throw new Error('Task requires its session web bundle.');
export default defineConfig([{ ...routed[0], exports: false }, routed[1]]);
