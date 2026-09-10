import { constants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import {
  applyHashlineEdits,
  normalizeFileTag,
  normalizeToLf,
  stripBom,
  type PreparedHashlineEdit,
} from '@agimon-ai/doompi-hashline';
import { computeFileTag, decodeUtf8, displayPath, resolveInputPath } from '@agimon-ai/doompi-hashline/files';
import {
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
  type EditToolDetails,
} from '@earendil-works/pi-coding-agent';
import type { EditParams } from '../schemas/editTool.ts';

export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}

export async function executeHashlineEdit(
  params: EditParams,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ content: [{ type: 'text'; text: string }]; details: EditToolDetails }> {
  const absolutePath = resolveInputPath(params.path, cwd);
  const expectedHash = normalizeFileTag(params.hash);
  return withFileMutationQueue(absolutePath, async () => {
    assertNotAborted(signal);
    await access(absolutePath, constants.R_OK | constants.W_OK);
    const beforeBytes = await readFile(absolutePath);
    assertNotAborted(signal);

    const actualHash = computeFileTag(beforeBytes);
    if (actualHash !== expectedHash) {
      throw new Error(`Stale file hash ${expectedHash}. Current hash is ${actualHash}. Re-read the file and retry.`);
    }

    const hasBom = beforeBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const decoded = decodeUtf8(beforeBytes, params.path);
    const withoutBom = stripBom(decoded);
    const before = normalizeToLf(withoutBom);
    const applied = applyHashlineEdits(before, params.edits);
    const editedText = restoreOriginalLineEndings(withoutBom, applied.edits);
    if (normalizeToLf(editedText) !== applied.content) {
      throw new Error('Could not preserve the file line endings safely. The file was not changed.');
    }
    const diff = generateDiffString(before, applied.content);
    const patch = generateUnifiedPatch(displayPath(absolutePath, cwd), before, applied.content);
    const details: EditToolDetails = { diff: diff.diff, patch, firstChangedLine: diff.firstChangedLine };

    assertNotAborted(signal);
    const currentBytes = await readFile(absolutePath);
    if (!currentBytes.equals(beforeBytes)) {
      throw new Error('The file changed while the edit was being prepared. Re-read it and retry.');
    }
    assertNotAborted(signal);

    if (applied.content !== before) {
      const output = Buffer.from(`${hasBom ? '\ufeff' : ''}${editedText}`, 'utf8');
      await writeFile(absolutePath, output);
    }

    const count = applied.edits.length;
    const noun = count === 1 ? 'range' : 'ranges';
    const message =
      applied.content === before ? `No changes needed in ${params.path}.` : `Edited ${params.path} (${count} ${noun}).`;
    return { content: [{ type: 'text', text: `${message} Re-read before editing it again.` }], details };
  });
}

interface LineToken {
  readonly text: string;
  readonly ending: '\r\n' | '\n' | '\r' | '';
}

function restoreOriginalLineEndings(original: string, edits: readonly PreparedHashlineEdit[]): string {
  const tokens = tokenizeLines(original);
  const defaultEnding = tokens.find((token) => token.ending !== '')?.ending ?? '\n';
  for (const edit of [...edits].reverse()) {
    const start = edit.from.line - 1;
    const count = edit.to.line - edit.from.line + 1;
    const removed = tokens.slice(start, start + count);
    const inheritedEnding = removed.at(-1)?.ending ?? '';
    const internalEnding = removed.find((token) => token.ending !== '')?.ending ?? defaultEnding;
    const lines = replacementLines(edit.content);
    if (lines.length === 0 && removed.at(-1)?.ending === '' && start > 0) {
      const previous = tokens[start - 1];
      if (previous) tokens[start - 1] = { ...previous, ending: '' };
    }
    const replacements = lines.map<LineToken>((text, index) => ({
      text,
      ending: index === lines.length - 1 ? inheritedEnding : internalEnding,
    }));
    tokens.splice(start, count, ...replacements);
  }
  return tokens.map((token) => `${token.text}${token.ending}`).join('');
}

function tokenizeLines(content: string): LineToken[] {
  const tokens: LineToken[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== '\r' && character !== '\n') continue;
    const ending = character === '\r' && content[index + 1] === '\n' ? '\r\n' : character;
    tokens.push({ text: content.slice(start, index), ending });
    if (ending === '\r\n') index += 1;
    start = index + 1;
  }
  tokens.push({ text: content.slice(start), ending: '' });
  return tokens;
}

function replacementLines(content: string | null): string[] {
  if (content === null || content === '') return [];
  const normalized = normalizeToLf(content);
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed === '' ? [] : trimmed.split('\n');
}
