import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExternalEditResult } from '../types/questionnaire.js';

const UTF8_ENCODING = 'utf8';

function editorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
}

function quoteFileArgument(file: string): string {
  if (process.platform === 'win32') return `"${file.replaceAll('"', '\\"')}"`;
  return `'${file.replaceAll("'", `'\\''`)}'`;
}

function runEditor(command: string, file: string): Promise<ExternalEditResult | undefined> {
  return new Promise((resolve) => {
    const child = spawn(`${command} ${quoteFileArgument(file)}`, { shell: true, stdio: 'inherit' });
    let settled = false;
    const finish = (result: ExternalEditResult | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', (error) => finish({ status: 'failed', message: `External editor failed: ${error.message}` }));
    child.once('exit', (code, signal) => {
      if (code === 0) finish(undefined);
      else {
        finish({
          status: 'failed',
          message: `External editor exited with ${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}`,
        });
      }
    });
  });
}

export async function editQuestionnaireText(content: string): Promise<ExternalEditResult> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'doompi-user-feedback-'));
  const file = path.join(directory, 'response.md');
  try {
    await writeFile(file, content, UTF8_ENCODING);
    const failure = await runEditor(editorCommand(), file);
    if (failure) return failure;
    return { status: 'complete', content: await readFile(file, UTF8_ENCODING) };
  } catch (error) {
    return {
      status: 'failed',
      message: `External editor failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
