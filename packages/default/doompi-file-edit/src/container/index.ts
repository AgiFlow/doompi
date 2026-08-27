import { EditorConfigService } from '../adapters/EditorConfigService/EditorConfigService';
import { EditorLauncher } from '../adapters/EditorLauncher/EditorLauncher';
import { EditTracker } from '../adapters/EditTracker/EditTracker';
import { FileEditPaths } from '../adapters/FileEditPaths/FileEditPaths';
import { NodeSnapshotStoreAdapter } from '../adapters/node/snapshotStore';
import { NodeTreeManifestAdapter } from '../adapters/node/treeManifest';
import { FileEditWorkflow } from '../tui/fileEditWorkflow';
import { GitDiffService } from '../adapters/GitDiffService/GitDiffService';
import { TimelineStore } from '../adapters/TimelineStore/TimelineStore';
import type { FileEditDependencies } from '../types';

/**
 * Compose the file-edit runtime.
 *
 * Construction order is the dependency order, so the graph is readable top to
 * bottom and a cycle is a compile error rather than a resolution failure at
 * runtime. Pass overrides to substitute a double in tests.
 */
export function createFileEditContainer(overrides: Partial<FileEditDependencies> = {}): FileEditDependencies {
  const paths = overrides.paths ?? new FileEditPaths();
  const timeline = overrides.timeline ?? new TimelineStore();
  const snapshots = overrides.snapshots ?? new NodeSnapshotStoreAdapter();
  const manifests = overrides.manifests ?? new NodeTreeManifestAdapter();
  const diffs = overrides.diffs ?? new GitDiffService();
  const editorConfig = overrides.editorConfig ?? new EditorConfigService();
  const editTracker = overrides.editTracker ?? new EditTracker(timeline, snapshots, manifests);
  const editorLauncher = overrides.editorLauncher ?? new EditorLauncher(editorConfig);
  const workflow = overrides.workflow ?? new FileEditWorkflow(timeline, diffs, editorConfig, editorLauncher);

  return { paths, timeline, snapshots, manifests, diffs, editorConfig, editTracker, editorLauncher, workflow };
}
