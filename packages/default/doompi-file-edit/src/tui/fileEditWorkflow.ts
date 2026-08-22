import { copyToClipboard, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FileEditOverlayComponent, type FileEditOverlayResult } from './fileEditOverlay';
import type { IEditorConfigService } from '../types/editorConfigService';
import type { EditorTui, IEditorLauncher } from '../types/editorLauncher';
import type { IGitDiffService } from '../types/gitDiffService';
import type { ITimelineStore } from '../types/timelineStore';
import type { IFileEditWorkflow } from '../types/fileEditWorkflow';

const FULLSCREEN_UI_OPTIONS = {
  overlay: true,
  overlayOptions: { anchor: 'top-left' as const, width: '100%' as const, maxHeight: '100%' as const, margin: 0 },
};
const ACTION_CLOSE = 'close';
const ACTION_COPY = 'copy';
const ACTION_OPEN = 'open';
const ACTION_REFRESH = 'refresh';
const LEVEL_INFO = 'info';
const LEVEL_ERROR = 'error';

export class FileEditWorkflow implements IFileEditWorkflow {
  constructor(
    private readonly timeline: ITimelineStore,
    private readonly diffs: IGitDiffService,
    private readonly config: IEditorConfigService,
    private readonly launcher: IEditorLauncher,
  ) {}

  async open(ctx: ExtensionContext): Promise<void> {
    let keepOpen = true;
    while (keepOpen) {
      const entries = await this.timeline.list();
      const diffs = await Promise.all(entries.map((entry) => this.diffs.diff(ctx.cwd, entry.path)));
      const editor = await this.launcher.resolve();
      let terminal: EditorTui | undefined;
      const result = await ctx.ui.custom<FileEditOverlayResult>((tui, theme, _keybindings, done) => {
        terminal = tui;
        return new FileEditOverlayComponent(
          tui,
          theme,
          {
            cwd: ctx.cwd,
            entries,
            diffs,
            editor,
            configPath: this.config.path(),
          },
          done,
        );
      }, FULLSCREEN_UI_OPTIONS);
      if (result.action === ACTION_CLOSE) return;
      const selected = entries[result.index];
      const diff = diffs[result.index];
      if (!selected || !diff) continue;
      if (result.action === ACTION_COPY) {
        await copyToClipboard(selected.path);
        ctx.ui.notify(`Copied ${selected.path}`, LEVEL_INFO);
      } else if (result.action === ACTION_OPEN) {
        if (!terminal) {
          ctx.ui.notify('Terminal editor is unavailable outside the interactive overlay', LEVEL_ERROR);
          continue;
        }
        const launched = await this.launcher.launch(selected.path, diff.suggestedLine, terminal);
        if (!launched.success) ctx.ui.notify(`Could not open editor: ${launched.error}`, LEVEL_ERROR);
      } else if (result.action === ACTION_REFRESH) {
        keepOpen = true;
      }
    }
  }
}
