import { Type } from 'typebox';

import type { DoomSocketContract } from './apiContracts';
import { HubSnapshotFrameSchema, HubUpsertFrameSchema, HubRemovedFrameSchema } from './httpApiContracts';
import { DOOM_SESSION_MANAGEMENT_SERVICE_ID, DOOM_SESSION_SERVICE_ID, type JsonValue } from './sessionProtocol';

const Text = Type.String();
const NumberValue = Type.Number();
const Flag = Type.Boolean();
const Json = Type.Unsafe<JsonValue>(
  Type.Unknown({
    description:
      'Strict JSON application value supplied by the active tool, journal entry, or extension; validated by the Pi codec.',
  }),
);
const Optional = Type.Optional;
const Strings = Type.Array(Text);
const Model = Type.Object({ provider: Text, id: Text });
const Thinking = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('max'),
  Type.Literal('xhigh'),
]);
const Phase = Type.Union([
  Type.Literal('idle'),
  Type.Literal('turn'),
  Type.Literal('compaction'),
  Type.Literal('retry'),
]);
const Image = Type.Object({ type: Type.Literal('image'), data: Text, mimeType: Text });
const TextPart = Type.Object({ type: Type.Literal('text'), text: Text });
const Content = Type.Union([Image, TextPart]);
const User = Type.Object({
  id: Text,
  role: Type.Literal('user'),
  content: Type.Array(Content),
  timestamp: NumberValue,
});
const Transcript = Type.Union([
  User,
  Type.Object({
    id: Text,
    role: Type.Literal('assistant'),
    content: Type.Array(
      Type.Union([
        TextPart,
        Type.Object({ type: Type.Literal('thinking'), thinking: Text, redacted: Optional(Type.Literal(true)) }),
        Type.Object({ type: Type.Literal('toolCall'), toolCallId: Text, toolName: Text, input: Json }),
      ]),
    ),
    model: Model,
    status: Type.Union([
      Type.Literal('streaming'),
      Type.Literal('complete'),
      Type.Literal('aborted'),
      Type.Literal('error'),
    ]),
    stopReason: Optional(
      Type.Union([
        Type.Literal('stop'),
        Type.Literal('length'),
        Type.Literal('toolUse'),
        Type.Literal('aborted'),
        Type.Literal('error'),
      ]),
    ),
    errorMessage: Optional(Text),
    timestamp: NumberValue,
  }),
  Type.Object({
    id: Text,
    role: Type.Literal('tool'),
    toolCallId: Text,
    toolName: Text,
    input: Json,
    content: Type.Array(Content),
    details: Optional(Json),
    status: Type.Union([Type.Literal('running'), Type.Literal('complete'), Type.Literal('error')]),
    isError: Flag,
    timestamp: NumberValue,
  }),
]);
const Usage = Type.Object({
  input: NumberValue,
  output: NumberValue,
  cacheRead: NumberValue,
  cacheWrite: NumberValue,
  total: NumberValue,
});
const Message = Type.Object({ text: Text, images: Optional(Type.Array(Image)) });
const Frame = Type.Intersect([Type.Object({ type: Text }), Type.Record(Text, Json)], {
  description: 'Discriminated extension presentation frame; selected channel schemas describe package payloads.',
});
const HubClientFrame = Type.Union([
  Type.Object({ type: Type.Union([Type.Literal('subscribe'), Type.Literal('unsubscribe')]), sessionId: Text }),
  Type.Object({
    type: Type.Union([Type.Literal('subscribe_thread'), Type.Literal('unsubscribe_thread')]),
    sessionId: Text,
    threadId: Text,
  }),
  Type.Object({
    type: Type.String({ not: { enum: ['subscribe', 'unsubscribe', 'subscribe_thread', 'unsubscribe_thread'] } }),
    sessionId: Text,
    payload: Json,
  }),
]);
const HubServerFrame = Type.Union([
  HubSnapshotFrameSchema,
  HubUpsertFrameSchema,
  HubRemovedFrameSchema,
  Type.Object({ type: Type.Literal('thread_frame'), sessionId: Text, threadId: Text, frame: Frame }),
  Type.Object({ type: Type.Literal('thread_backlog'), sessionId: Text, threadId: Text, frames: Type.Array(Frame) }),
  Type.Object({
    type: Type.String({
      not: { enum: ['sessions_snapshot', 'session_upsert', 'session_removed', 'thread_frame', 'thread_backlog'] },
    }),
    sessionId: Text,
    payload: Json,
  }),
]);
const ProtocolEvent = Type.Object({ sequence: NumberValue, frame: Frame });
const Update = Type.Union([
  Type.Object({
    sessionUpdate: Type.Union([
      Type.Literal('user_message'),
      Type.Literal('agent_message'),
      Type.Literal('agent_thought'),
    ]),
    messageId: Text,
    content: Type.Array(Content),
  }),
  Type.Object({
    sessionUpdate: Type.Literal('tool_call_update'),
    toolCallId: Text,
    title: Optional(Text),
    kind: Optional(Text),
    status: Optional(
      Type.Union([
        Type.Literal('pending'),
        Type.Literal('in_progress'),
        Type.Literal('completed'),
        Type.Literal('failed'),
        Type.Literal('cancelled'),
      ]),
    ),
    content: Optional(Type.Array(Type.Object({ type: Type.Literal('content'), content: Content }))),
    rawInput: Optional(Json),
    rawOutput: Optional(Json),
  }),
  Type.Object({
    sessionUpdate: Type.Literal('state_update'),
    state: Type.Union([Type.Literal('running'), Type.Literal('idle'), Type.Literal('requires_action')]),
    stopReason: Optional(
      Type.Union([
        Type.Literal('end_turn'),
        Type.Literal('max_tokens'),
        Type.Literal('max_turn_requests'),
        Type.Literal('refusal'),
        Type.Literal('cancelled'),
        Type.Unsafe<`_${string}`>(Type.String({ pattern: '^_' })),
      ]),
    ),
  }),
]);
export const SessionServiceStateSchema = Type.Object({
  snapshot: Type.Object({
    id: Text,
    cwd: Text,
    name: Optional(Text),
    createdAt: NumberValue,
    updatedAt: NumberValue,
    phase: Phase,
    model: Model,
    thinkingLevel: Thinking,
    attached: Flag,
    locked: Flag,
    revision: NumberValue,
    queuedSteer: Type.Array(User),
    queuedSteerCount: NumberValue,
  }),
  progress: Type.Union([
    Type.Null(),
    Type.Union([
      Type.Object({ type: Type.Literal('item_started'), item: Transcript }),
      Type.Object({ type: Type.Literal('item_updated'), item: Transcript }),
      Type.Object({ type: Type.Literal('item_finished'), item: Transcript }),
    ]),
  ]),
  updates: Optional(Type.Array(Type.Object({ sequence: NumberValue, update: Update }))),
  presentation: Optional(
    Type.Object({
      revision: NumberValue,
      dropped: NumberValue,
      resetRevision: Optional(NumberValue),
      events: Type.Array(ProtocolEvent),
      projections: Type.Array(ProtocolEvent),
    }),
  ),
  inFlight: Optional(Type.Array(Transcript)),
});
export const SessionMethodSchemas = {
  readTranscriptPage: {
    input: Type.Tuple([
      Type.Object({
        cursor: Optional(Text),
        direction: Optional(Type.Union([Type.Literal('older'), Type.Literal('newer')])),
        limit: Optional(NumberValue),
        threadId: Optional(Text),
      }),
    ]),
    output: Type.Object({
      entries: Type.Array(Json),
      startCursor: Type.Union([Text, Type.Null()]),
      endCursor: Type.Union([Text, Type.Null()]),
      olderCursor: Type.Union([Text, Type.Null()]),
      newerCursor: Type.Union([Text, Type.Null()]),
      generation: NumberValue,
      revision: NumberValue,
      context: Type.Array(Json),
      drafts: Type.Array(Transcript),
    }),
  },
  prompt: {
    input: Type.Tuple([
      Type.Union([
        Text,
        Type.Object({
          ...Message.properties,
          waitFor: Optional(Type.Union([Type.Literal('accepted'), Type.Literal('settled')])),
        }),
      ]),
    ]),
  },
  steer: { input: Type.Tuple([Type.Union([Text, Message])]) },
  abort: { input: Type.Tuple([]) },
  setModel: { input: Type.Tuple([Model]) },
  setThinking: { input: Type.Tuple([Thinking]) },
  followUp: { input: Type.Tuple([Message]) },
  clearQueue: { input: Type.Tuple([]), output: Type.Object({ steering: Strings, followUp: Strings }) },
  rewind: {
    input: Type.Tuple([
      Type.Object({
        itemId: Text,
        summarize: Optional(Flag),
        customInstructions: Optional(Text),
        replaceInstructions: Optional(Flag),
        label: Optional(Text),
      }),
    ]),
    output: Type.Object({
      editorText: Optional(Text),
      cancelled: Flag,
      aborted: Optional(Flag),
      summaryEntry: Optional(
        Type.Object({
          id: Text,
          parentId: Type.Union([Text, Type.Null()]),
          timestamp: Text,
          fromId: Text,
          summary: Text,
          details: Optional(Json),
          usage: Optional(Usage),
          fromHook: Optional(Flag),
        }),
      ),
    }),
  },
  extensionUiResponse: {
    input: Type.Tuple([
      Type.Union([
        Type.Object({ id: Text, value: Text }),
        Type.Object({ id: Text, confirmed: Flag }),
        Type.Object({ id: Text, cancelled: Type.Literal(true) }),
      ]),
    ]),
  },
  getState: {
    input: Type.Tuple([]),
    output: Type.Object({
      model: Optional(Model),
      thinkingLevel: Thinking,
      isStreaming: Flag,
      isCompacting: Flag,
      steeringMode: Type.Union([Type.Literal('all'), Type.Literal('one-at-a-time')]),
      followUpMode: Type.Union([Type.Literal('all'), Type.Literal('one-at-a-time')]),
      sessionFile: Optional(Text),
      sessionId: Text,
      sessionName: Optional(Text),
      autoCompactionEnabled: Flag,
      messageCount: NumberValue,
      pendingMessageCount: NumberValue,
    }),
  },
  getSessionStats: {
    input: Type.Tuple([]),
    output: Type.Object({
      sessionFile: Optional(Text),
      sessionId: Text,
      totalMessages: NumberValue,
      tokens: Usage,
      cost: NumberValue,
      contextUsage: Optional(
        Type.Object({
          tokens: Type.Union([NumberValue, Type.Null()]),
          contextWindow: NumberValue,
          percent: Type.Union([NumberValue, Type.Null()]),
        }),
      ),
    }),
  },
  getCommands: {
    input: Type.Tuple([]),
    output: Type.Array(
      Type.Object({
        name: Text,
        description: Optional(Text),
        source: Type.Union([Type.Literal('extension'), Type.Literal('prompt'), Type.Literal('skill')]),
        sourceInfo: Optional(
          Type.Object({
            path: Text,
            source: Text,
            scope: Type.Union([Type.Literal('user'), Type.Literal('project'), Type.Literal('temporary')]),
            origin: Type.Union([Type.Literal('package'), Type.Literal('top-level')]),
            baseDir: Optional(Text),
          }),
        ),
      }),
    ),
  },
  getAvailableModels: { input: Type.Tuple([]), output: Type.Array(Model) },
  getAvailableThinkingLevels: { input: Type.Tuple([]), output: Type.Array(Thinking) },
  compact: { input: Type.Tuple([Type.Object({ customInstructions: Optional(Text) })]), output: Json },
  setName: { input: Type.Tuple([Text]) },
};

const ErrorSchema = Type.Object({ code: Text, message: Text });
export const sessionSocketContracts: DoomSocketContract[] = [
  ...Object.entries(SessionMethodSchemas).map(([member, definition]): DoomSocketContract => ({
    id: `session.${member}`,
    scope: 'session',
    service: DOOM_SESSION_SERVICE_ID,
    member,
    direction: 'client-to-server',
    kind: 'method',
    description: `Session ${member}. Arguments exclude the process-local Chord Context. A void result is omitted from the successful Pi response.`,
    ...definition,
    errors: ErrorSchema,
  })),
  {
    id: 'session.state',
    scope: 'session',
    service: DOOM_SESSION_SERVICE_ID,
    member: 'state',
    direction: 'server-to-client',
    kind: 'state',
    input: SessionServiceStateSchema,
    description: 'Reconstructed session state after Chord snapshot/delta decoding.',
  },
  {
    id: 'management.attach',
    scope: 'global',
    service: DOOM_SESSION_MANAGEMENT_SERVICE_ID,
    member: 'attach',
    direction: 'client-to-server',
    kind: 'method',
    input: Type.Tuple([Text]),
    errors: ErrorSchema,
    description: 'Attach this presentation to a session. Pi publishes an out-of-band attachment update.',
  },
  {
    id: 'management.detach',
    scope: 'global',
    service: DOOM_SESSION_MANAGEMENT_SERVICE_ID,
    member: 'detach',
    direction: 'client-to-server',
    kind: 'method',
    input: Type.Tuple([]),
    errors: ErrorSchema,
    description: 'Detach this presentation from its selected session.',
  },
  {
    id: 'hub.send',
    scope: 'global',
    service: 'doompi.hub.v1',
    member: 'send',
    direction: 'client-to-server',
    kind: 'method',
    input: Type.Tuple([HubClientFrame]),
    errors: ErrorSchema,
    description: 'Send a hub subscription, thread, history, or selected extension channel frame.',
  },
  {
    id: 'hub.state',
    scope: 'global',
    service: 'doompi.hub.v1',
    member: 'state',
    direction: 'server-to-client',
    kind: 'state',
    input: Type.Object({ events: Type.Array(Type.Object({ sequence: NumberValue, frame: HubServerFrame })) }),
    description:
      'Reconstructed hub event replay window. Frame discriminators identify session and selected extension updates.',
  },
];
