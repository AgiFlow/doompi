import { EditorConfigService } from '../services/editorConfigService';
import { EditorLauncher } from '../services/editorLauncher';
import { EditTracker } from '../services/editTracker';
import { FileEditPaths } from '../services/fileEditPaths';
import { GitDiffService } from '../services/gitDiffService';
import { NodeGitStatusAdapter } from '../services/gitStatus';
import { NodeSnapshotStoreAdapter } from '../services/snapshotStore';
import { TimelineStore } from '../services/timelineStore';
import { NodeTreeManifestAdapter } from '../services/treeManifest';
import type { FileEditDependencies } from '../types';
import { FileEditWorkflow } from './fileEditWorkflow';

/**
 * Compose the file-edit runtime.
 *
 * Construction order is the dependency order, so the graph is readable top to
 * bottom and a cycle is a compile error rather than a resolution failure at
 * runtime. Pass overrides to substitute a double in tests.
 */
export function createFileEditDependencies(overrides: Partial<FileEditDependencies> = {}): FileEditDependencies {
  const paths = overrides.paths ?? new FileEditPaths();
  const timeline = overrides.timeline ?? new TimelineStore();
  const snapshots = overrides.snapshots ?? new NodeSnapshotStoreAdapter();
  const manifests = overrides.manifests ?? new NodeTreeManifestAdapter();
  const diffs = overrides.diffs ?? new GitDiffService();
  const editorConfig = overrides.editorConfig ?? new EditorConfigService();
  const editTracker =
    overrides.editTracker ?? new EditTracker(timeline, snapshots, manifests, { git: new NodeGitStatusAdapter() });
  const editorLauncher = overrides.editorLauncher ?? new EditorLauncher(editorConfig);
  const workflow = overrides.workflow ?? new FileEditWorkflow(timeline, diffs, editorConfig, editorLauncher);

  return { paths, timeline, snapshots, manifests, diffs, editorConfig, editTracker, editorLauncher, workflow };
}
