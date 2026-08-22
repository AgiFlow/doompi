import { buildSessionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  baselineUsageIsSettled,
  checkpointSummaryFromEntry,
  contextDetailsFromUnknown,
  createInitialState,
  fileDetailsFromUnknown,
  fileOperationsFromMessages,
  isStructuredCheckpoint,
  latestCheckpointArtifactEntry,
  mergeFileDetails,
  parseCheckpointDecision,
  parseState,
  projectContextMessages,
  retainedMessagesAfterSnapshot,
  thresholdTokens,
  withCanonicalFileSections,
} from '../src/adapters/compaction/policy';
import { CHECKPOINT_MESSAGE_TYPE, CONTEXT_MESSAGE_TYPE } from '../src/types/constants.ts';

const STRUCTURED_CHECKPOINT = `## Goal
Ship staged compaction.
## Constraints & Preferences
Keep manual compaction.
## Progress
### Done
Policy designed.
### In Progress
Implementation.
### Blocked
None.
## Key Decisions
Use iterative checkpoints.
## Next Steps
Run tests.
## Critical Context
src/extension.ts`;

function assistantEntry(text: string, stopReason: 'stop' | 'aborted' = 'stop'): SessionEntry {
  return {
    type: 'message',
    id: 'assistant',
    parentId: 'request',
    timestamp: '2026-08-03T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: 1,
    },
  };
}

describe('autocompact policy', () => {
  it('uses exact percentages for a 128k context window', () => {
    expect(thresholdTokens(1, 128_000)).toBe(64_000);
    expect(thresholdTokens(2, 128_000)).toBe(96_000);
    // The raw 95% ratio lands at 121_600, above the 111_616 point where Pi compacts natively.
    expect(thresholdTokens(3, 128_000)).toBe(111_616);
  });

  it('caps thresholds for a one-million-token context window', () => {
    expect(thresholdTokens(1, 1_000_000)).toBe(200_000);
    expect(thresholdTokens(2, 1_000_000)).toBe(500_000);
    expect(thresholdTokens(3, 1_000_000)).toBe(800_000);
  });

  it('measures thresholds from the latest compaction baseline', () => {
    expect(thresholdTokens(1, 200_000, 30_000)).toBe(115_000);
    expect(thresholdTokens(2, 200_000, 30_000)).toBe(157_500);
    expect(thresholdTokens(3, 200_000, 30_000)).toBe(183_616);
    expect(thresholdTokens(1, 200_000, 250_000)).toBe(200_000);
  });

  it('keeps every staged threshold below the point where Pi compacts natively', () => {
    // Pi compacts once usage passes contextWindow - 16_384, so an unclamped ladder would let
    // native compaction win before the staged passes ever fired.
    expect(thresholdTokens(3, 200_000)).toBe(183_616);
    expect(thresholdTokens(3, 32_000)).toBe(15_616);
    expect(thresholdTokens(1, 32_000)).toBe(15_616);
  });

  it('extracts the agent-owned pass 2 decision from the checkpoint', () => {
    expect(parseCheckpointDecision(`<shouldCompact>true</shouldCompact>\n${STRUCTURED_CHECKPOINT}`)).toEqual({
      shouldCompact: true,
      summary: STRUCTURED_CHECKPOINT,
    });
    expect(parseCheckpointDecision(`<shouldCompact>false</shouldCompact>\n${STRUCTURED_CHECKPOINT}`)).toEqual({
      shouldCompact: false,
      summary: STRUCTURED_CHECKPOINT,
    });
    expect(parseCheckpointDecision(STRUCTURED_CHECKPOINT)).toEqual({ summary: STRUCTURED_CHECKPOINT });
  });

  it('recognizes only complete structured checkpoints', () => {
    expect(isStructuredCheckpoint(STRUCTURED_CHECKPOINT)).toBe(true);
    expect(isStructuredCheckpoint('## Goal\nIncomplete')).toBe(false);
  });

  it('retains parent messages added after the snapshot and excludes staged checkpoints', () => {
    const snapshot = { ...assistantEntry('snapshot'), id: 'snapshot', parentId: null } as SessionEntry;
    const staged: SessionEntry = {
      type: 'custom_message',
      id: 'staged',
      parentId: 'snapshot',
      timestamp: '2026-08-03T00:00:00.000Z',
      customType: CHECKPOINT_MESSAGE_TYPE,
      content: 'internal staged summary',
      display: false,
    };
    const newer = { ...assistantEntry('newer'), id: 'newer', parentId: 'staged' } as SessionEntry;

    expect(JSON.stringify(retainedMessagesAfterSnapshot([snapshot, staged, newer], 'snapshot'))).toContain('newer');
    expect(JSON.stringify(retainedMessagesAfterSnapshot([snapshot, staged, newer], 'snapshot'))).not.toContain(
      'internal staged summary',
    );
    expect(retainedMessagesAfterSnapshot([snapshot], 'missing')).toEqual([]);
  });

  it('finds the newest checkpoint artifact on the branch', () => {
    const staged: SessionEntry = {
      type: 'custom_message',
      id: 'staged',
      parentId: null,
      timestamp: '2026-08-03T00:00:00.000Z',
      customType: CHECKPOINT_MESSAGE_TYPE,
      content: 'staged summary',
      display: false,
    };
    const marker: SessionEntry = { ...staged, id: 'marker', customType: CONTEXT_MESSAGE_TYPE, content: 'committed' };
    const assistant = { ...assistantEntry('newer'), id: 'newer' } as SessionEntry;

    expect(latestCheckpointArtifactEntry([staged, marker, assistant])?.id).toBe('marker');
    expect(latestCheckpointArtifactEntry([marker, staged])?.id).toBe('staged');
    expect(latestCheckpointArtifactEntry([assistant])).toBeUndefined();
  });

  it('chains from a staged checkpoint entry that stays out of the agent context', () => {
    const snapshot = { ...assistantEntry('snapshot'), id: 'snapshot' } as SessionEntry;
    const staged: SessionEntry = {
      type: 'custom',
      id: 'staged',
      parentId: 'snapshot',
      timestamp: '2026-08-03T00:00:00.000Z',
      customType: CHECKPOINT_MESSAGE_TYPE,
      data: { version: 2, cycle: 1, pass: 1, requestId: 'request-1', summary: ' staged summary ' },
    };

    expect(latestCheckpointArtifactEntry([snapshot, staged])?.id).toBe('staged');
    expect(checkpointSummaryFromEntry(staged)).toBe('staged summary');
    expect(JSON.stringify(buildSessionContext([snapshot, staged]).messages)).not.toContain('staged summary');
  });

  it('treats the baseline as settled only after an assistant responds past the newest boundary', () => {
    const assistant = { ...assistantEntry('before'), id: 'before' } as SessionEntry;
    const marker: SessionEntry = {
      type: 'custom_message',
      id: 'marker',
      parentId: null,
      timestamp: '2026-08-03T00:00:00.000Z',
      customType: CONTEXT_MESSAGE_TYPE,
      content: 'committed',
      display: false,
    };
    const settled = { ...assistantEntry('after'), id: 'after' } as SessionEntry;
    const aborted = { ...assistantEntry('aborted', 'aborted'), id: 'aborted' } as SessionEntry;

    expect(baselineUsageIsSettled([assistant, marker])).toBe(false);
    expect(baselineUsageIsSettled([assistant, marker, aborted])).toBe(false);
    expect(baselineUsageIsSettled([assistant, marker, settled])).toBe(true);
    expect(baselineUsageIsSettled([assistant])).toBe(true);
  });

  it('parses valid state and rejects malformed state', () => {
    const state = createInitialState();
    state.requestId = 'request';
    expect(parseState(state)).toEqual(state);
    const legacyState = { ...state } as Record<string, unknown>;
    delete legacyState.baselineTokens;
    delete legacyState.baselinePending;
    delete legacyState.checkpointQueue;
    delete legacyState.exhaustedPasses;
    delete legacyState.invalidAttempts;
    expect(parseState(legacyState)).toMatchObject({
      baselineTokens: 0,
      baselinePending: false,
      checkpointQueue: [],
      exhaustedPasses: [],
      invalidAttempts: 0,
    });
    expect(parseState({ ...state, pass: 4 })).toBeUndefined();
    expect(parseState({ ...state, phase: 'invalid' })).toBeUndefined();
    expect(parseState({ ...state, baselineTokens: -1 })).toBeUndefined();
    expect(parseState({ ...state, baselinePending: 'yes' })).toBeUndefined();
    expect(parseState({ ...state, checkpointQueue: [2, 1] })).toBeUndefined();
    expect(parseState({ ...state, checkpointQueue: [1, 1] })).toBeUndefined();
    expect(parseState({ ...state, checkpointQueue: [4] })).toBeUndefined();
    expect(parseState({ ...state, exhaustedPasses: [4] })).toBeUndefined();
    expect(parseState({ ...state, invalidAttempts: -1 })).toBeUndefined();
    expect(parseState({ ...state, readFiles: [1] })).toBeUndefined();
    expect(parseState({ ...state, requestId: 1 })).toBeUndefined();
    expect(parseState({ ...state, compactionPass: 1 })).toBeUndefined();
    expect(parseState({ ...state, version: 1 })).toBeUndefined();
    expect(parseState({ ...state, latestCheckpointSnapshotLeafId: 1 })).toBeUndefined();
    expect(parseState({ ...state, lastAttemptLeafId: 1 })).toBeUndefined();
    expect(parseState({ ...state, snapshotLeafId: 1 })).toBeUndefined();
    expect(parseState({ ...state, snapshotTokens: -1 })).toBeUndefined();
    expect(parseState({ ...state, pendingCheckpoint: 1 })).toBeUndefined();
    expect(parseState(null)).toBeUndefined();
  });

  it('reads checkpoint summaries from compaction, custom, and assistant entries', () => {
    const compaction: SessionEntry = {
      type: 'compaction',
      id: 'compaction',
      parentId: null,
      timestamp: '2026-08-03T00:00:00.000Z',
      summary: ' Compacted checkpoint ',
      firstKeptEntryId: 'keep',
      tokensBefore: 100,
    };
    const customText: SessionEntry = {
      type: 'custom_message',
      id: 'custom-text',
      parentId: 'compaction',
      timestamp: '2026-08-03T00:00:00.000Z',
      customType: 'checkpoint',
      content: ' Custom checkpoint ',
      display: false,
    };
    const customBlocks: SessionEntry = {
      ...customText,
      id: 'custom-blocks',
      content: [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' },
      ],
    };
    const user: SessionEntry = {
      type: 'message',
      id: 'user',
      parentId: 'custom-blocks',
      timestamp: '2026-08-03T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'User message' }], timestamp: 1 },
    };

    expect(checkpointSummaryFromEntry(compaction)).toBe('Compacted checkpoint');
    expect(checkpointSummaryFromEntry(customText)).toBe('Custom checkpoint');
    expect(checkpointSummaryFromEntry(customBlocks)).toBe('First\nSecond');
    expect(checkpointSummaryFromEntry(assistantEntry(' Assistant checkpoint '))).toBe('Assistant checkpoint');
    expect(checkpointSummaryFromEntry(user)).toBeUndefined();
    expect(checkpointSummaryFromEntry(undefined)).toBeUndefined();
  });

  it('keeps modified files out of read-only details and writes canonical sections', () => {
    const state = createInitialState();
    state.readFiles = ['src/read.ts', 'src/changed.ts'];
    const details = mergeFileDetails(state, {
      read: new Set(['src/new-read.ts']),
      written: new Set(['src/new.ts']),
      edited: new Set(['src/changed.ts']),
    });

    expect(details).toEqual({
      readFiles: ['src/new-read.ts', 'src/read.ts'],
      modifiedFiles: ['src/changed.ts', 'src/new.ts'],
    });
    expect(withCanonicalFileSections('Summary.', details)).toContain(
      '<modified-files>\nsrc/changed.ts\nsrc/new.ts\n</modified-files>',
    );
    expect(fileDetailsFromUnknown(details)).toEqual(details);
    expect(fileDetailsFromUnknown({ readFiles: 'invalid', modifiedFiles: [] })).toBeUndefined();
  });

  it('projects the latest logical checkpoint into model context without changing the branch', () => {
    const archived = { ...assistantEntry('archived'), id: 'archived', parentId: null } as SessionEntry;
    const retained = { ...assistantEntry('retained'), id: 'retained', parentId: 'archived' } as SessionEntry;
    const marker: SessionEntry = {
      type: 'custom_message',
      id: 'marker',
      parentId: 'retained',
      timestamp: '2026-08-03T00:00:00.000Z',
      customType: CONTEXT_MESSAGE_TYPE,
      content: STRUCTURED_CHECKPOINT,
      display: false,
      details: {
        readFiles: [],
        modifiedFiles: [],
        retainedMessages: buildSessionContext([retained]).messages,
        doomAutocompact: {
          version: 2,
          cycle: 1,
          pass: 2,
          requestId: 'request-1',
          snapshotLeafId: 'archived',
          tokensBefore: 100_000,
        },
      },
    };
    const newer = { ...assistantEntry('newer'), id: 'newer', parentId: 'marker' } as SessionEntry;
    const branch = [archived, retained, marker, newer];
    const projection = projectContextMessages(buildSessionContext(branch).messages, branch);

    expect(branch.map((entry) => entry.id)).toEqual(['archived', 'retained', 'marker', 'newer']);
    expect(projection.messages.map((message) => message.role)).toEqual(['compactionSummary', 'assistant', 'assistant']);
    expect(JSON.stringify(projection.messages)).not.toContain('archived');
    expect(JSON.stringify(projection.messages)).toContain('retained');
    expect(JSON.stringify(projection.messages)).toContain('newer');
    expect(projection.retainedMessageCount).toBe(1);
  });

  it('fails open for malformed markers and ignores markers before a later native compaction', () => {
    const archived = { ...assistantEntry('archived'), id: 'archived', parentId: null } as SessionEntry;
    const malformed: SessionEntry = {
      type: 'custom_message',
      id: 'malformed',
      parentId: 'archived',
      timestamp: '2026-08-03T00:00:00.000Z',
      customType: CONTEXT_MESSAGE_TYPE,
      content: STRUCTURED_CHECKPOINT,
      display: false,
      details: {},
    };
    const malformedMessages = buildSessionContext([archived, malformed]).messages;
    const malformedProjection = projectContextMessages(malformedMessages, [archived, malformed]);
    expect(malformedProjection).toMatchObject({ messages: malformedMessages, invalidMarker: true });

    const native: SessionEntry = {
      type: 'compaction',
      id: 'native',
      parentId: 'malformed',
      timestamp: '2026-08-03T00:00:00.000Z',
      summary: 'native summary',
      firstKeptEntryId: 'archived',
      tokensBefore: 10,
    };
    const nativeMessages = buildSessionContext([archived, malformed, native]).messages;
    expect(projectContextMessages(nativeMessages, [archived, malformed, native])).toEqual({
      messages: nativeMessages,
      retainedMessageCount: 0,
    });
    expect(contextDetailsFromUnknown({})).toBeUndefined();
  });

  it('extracts built-in file operations from assistant tool calls', () => {
    const assistant = assistantEntry('tools');
    if (assistant.type !== 'message' || assistant.message.role !== 'assistant') throw new Error('invalid fixture');
    assistant.message.content = [
      { type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'src/read.ts' } },
      { type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'src/write.ts' } },
      { type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'src/edit.ts' } },
    ];

    const fileOps = fileOperationsFromMessages([assistant.message]);
    expect([...fileOps.read]).toEqual(['src/read.ts']);
    expect([...fileOps.written]).toEqual(['src/write.ts']);
    expect([...fileOps.edited]).toEqual(['src/edit.ts']);
  });
});
