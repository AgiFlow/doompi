import type { IEditorConfigService } from '../types/editorConfigService';
import type { IEditorLauncher } from '../types/editorLauncher';
import type { IEditTracker } from '../types/editTracker';
import type { IFileEditPaths } from '../types/fileEditPaths';
import type { IFileEditWorkflow } from '../types/fileEditWorkflow';
import type { IGitDiffService } from '../types/gitDiffService';
import type { SnapshotStorePort } from '../types/snapshotStore';
import type { ITimelineStore } from '../types/timelineStore';
import type { TreeManifestPort } from '../types/treeManifest';

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
