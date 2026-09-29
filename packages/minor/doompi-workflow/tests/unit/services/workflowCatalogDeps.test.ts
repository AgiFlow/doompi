import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultCatalogDeps } from '../../../src/services/workflowCatalogDeps';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function workflowFile(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-catalog-deps-'));
  directories.push(directory);
  const file = path.join(directory, 'check.workflow.yml');
  fs.writeFileSync(file, contents);
  return file;
}

const workflow = (runConfig: string) => `name: Check
jobs:
  agent:
    steps:
      - name: Write a note
        run: echo fallback
        runConfig:
${runConfig}
        customRun:
          prompt: Write the note.
`;

describe('defaultCatalogDeps', () => {
  it('marks a workflow DoomPi would fail mid-run, such as a misspelled runConfig key, as one that cannot launch', () => {
    const detail = defaultCatalogDeps().summarize(workflowFile(workflow('          majormode: dev')));

    expect(detail.error).toBe('jobs.agent › Write a note: runConfig key "majormode" is not a host setting.');
  });

  it("leaves a workflow that only uses DoomPi's keys as it is", () => {
    const detail = defaultCatalogDeps().summarize(
      workflowFile(workflow('          majorMode: dev\n          thinking: low')),
    );

    expect(detail.error).toBeUndefined();
    expect(detail.jobs).toHaveLength(1);
  });
});
