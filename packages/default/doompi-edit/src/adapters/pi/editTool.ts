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
import { renderHashlineCall, renderHashlineEditResult } from '@agimon-ai/doompi-ui/hashlineRendering';
import {
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
  type EditToolDetails,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { EditParamsSchema, type EditParams } from '../../schemas/editTool.ts';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function registerHashlineEditTool(pi: Pick<ExtensionAPI, 'registerTool'>): void {
  pi.registerTool({
    name: 'edit',
    label: 'edit',
    description:
      'Edit one file using its exact snapshot hash and inclusive anchors such as 5#abc from read or grep. Each from and to value must contain one anchor, not a pasted block. All ranges refer to the original snapshot. Empty or omitted content deletes a range.',
    promptSnippet: 'Edit files with snapshot-bound hashline ranges',
    promptGuidelines: [
      'Copy path, hash, and anchors from the latest compatible read or grep result. Re-read after every successful edit.',
      'Pass one anchor such as 5#abc in each from and to value. Do not paste tagged lines or multiline blocks.',
      'Put multiple disjoint changes to one file in one edit call. All anchors must describe the original snapshot.',
      'Omit content or pass an empty string to delete an inclusive range. Merge overlapping ranges before calling edit.',
    ],
    parameters: EditParamsSchema,
    executionMode: 'parallel',
    renderShell: 'self',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeHashlineEdit(params as EditParams, ctx.cwd, signal);
    },
    renderCall(args, theme) {
      const input = args as EditParams;
      const count = input.edits.length;
      return renderHashlineCall('edit', input.path, [`${count} ${count === 1 ? 'range' : 'ranges'}`], theme);
    },
    renderResult(result, options, theme, context) {
      const input = context.args as EditParams;
      return renderHashlineEditResult(input.path, result, options, theme, context);
    },
  });
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

    const hasBom = beforeBytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
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

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
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
