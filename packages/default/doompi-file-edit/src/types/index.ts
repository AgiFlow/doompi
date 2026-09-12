import type { IEditorConfigService } from './editorConfigService';
import type { IEditorLauncher } from './editorLauncher';
import type { IEditTracker } from './editTracker';
import type { IFileEditPaths } from './fileEditPaths';
import type { IFileEditWorkflow } from './fileEditWorkflow';
import type { IGitDiffService } from './gitDiffService';
import type { SnapshotStorePort } from './snapshotStore';
import type { ITimelineStore } from './timelineStore';
import type { TreeManifestPort } from './treeManifest';

/** Everything the file-edit runtime is assembled from. */
export interface FileEditDependencies {
  readonly paths: IFileEditPaths;
  readonly timeline: ITimelineStore;
  readonly snapshots: SnapshotStorePort;
  readonly manifests: TreeManifestPort;
  readonly diffs: IGitDiffService;
  readonly editorConfig: IEditorConfigService;
  readonly editTracker: IEditTracker;
  readonly editorLauncher: IEditorLauncher;
  readonly workflow: IFileEditWorkflow;
}
