import fs from 'node:fs/promises';
import path from 'node:path';
import spawn from 'cross-spawn';
import { expandEditorTemplate, splitCommandLine } from '../../adapters/process/commandLine.ts';
import type { IEditorConfigService } from '../../types/editorConfigService';
import type { ResolvedEditor } from '../../types/domain';
import type { EditorLaunchResult, EditorTui, IEditorLauncher } from '../../types/editorLauncher';

export class EditorLauncher implements IEditorLauncher {
  constructor(private readonly config: IEditorConfigService) {}

  async resolve(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
  ): Promise<ResolvedEditor | undefined> {
    const configured = await this.config.command();
    const candidates: ResolvedEditor[] = [
      ...(configured ? [{ template: configured, source: 'configured' as const }] : []),
      ...(env.VISUAL ? [{ template: env.VISUAL, source: 'VISUAL' as const }] : []),
      ...(env.EDITOR ? [{ template: env.EDITOR, source: 'EDITOR' as const }] : []),
      { template: platform === 'win32' ? 'notepad {file}' : 'nano {file}', source: 'fallback' },
    ];
    for (const candidate of candidates) {
      const executable = splitCommandLine(candidate.template)[0];
      if (executable && (await this.isExecutable(executable, env, platform))) return candidate;
    }
    return undefined;
  }

  async launch(filePath: string, line: number, tui: EditorTui): Promise<EditorLaunchResult> {
    try {
      const editor = await this.resolve();
      if (!editor) return { success: false, error: 'No editor command could be resolved' };
      const [command, ...args] = expandEditorTemplate(editor.template, filePath, line);
      if (!command) return { success: false, error: 'Editor command must not be empty' };
      tui.stop();
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(command, args, { stdio: 'inherit', shell: false });
          child.once('error', reject);
          child.once('exit', () => resolve());
        });
      } finally {
        tui.start();
        tui.requestRender(true);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async isExecutable(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<boolean> {
    const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
    const locations =
      path.isAbsolute(command) || command.includes(path.sep) ? [''] : (env.PATH ?? '').split(path.delimiter);
    for (const location of locations) {
      for (const extension of extensions) {
        const candidate = location ? path.join(location, `${command}${extension}`) : `${command}${extension}`;
        try {
          await fs.access(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
          return true;
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES')))
            throw error;
        }
      }
    }
    return false;
  }
}
