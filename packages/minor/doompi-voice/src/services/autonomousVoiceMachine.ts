import { assign, cancel, emit, raise, type SnapshotFrom, setup } from 'xstate';
import { type NarrationBargeInEvidence, narrationBargeInIsActionable } from './narrationBargeIn.ts';
import type { VoiceCompositionState } from './transcriptPolicy.ts';

/** The failure code reported when no more specific one is available. */
const GENERIC_FAILURE_CODE = 'autonomous_voice_failed';
const GRACEFUL_STOP_TIMEOUT_MS = 20_000;
const GRACEFUL_STOP_TIMER_ID = 'autonomous-voice-graceful-stop';
const PLAYBACK_ECHO_TAIL_MS = 800;

export type AutonomousCandidateOutcome = 'committed' | 'discarded';

export interface AutonomousTurnIdentity {
  sessionId: string;
  captureId: string;
  turnId: string;
}

export interface AutonomousVoiceFailure {
  code: string;
  recoverable: boolean;
}

export interface AutonomousVoiceContext {
  sessionId?: string;
  captureId?: string;
  turnId?: string;
  revision?: number;
  candidateOutcome?: AutonomousCandidateOutcome;
  confirmedSpeech: boolean;
  narrationOverlapPromoted: boolean;
  stopRequested: boolean;
  hardStopRequested: boolean;
  playbackGeneration: number;
  compositionState: VoiceCompositionState;
  failure?: AutonomousVoiceFailure;
}

type CaptureIdentityEvent = AutonomousTurnIdentity & { type: string };
type RevisionEvent = AutonomousTurnIdentity & { revision: number; type: string };

export type AutonomousVoiceEvent =
  | { type: 'ENABLE_REQUESTED'; sessionId: string }
  | ({ type: 'ENABLE_SUCCEEDED' } & AutonomousTurnIdentity)
  | { type: 'ENABLE_FAILED'; sessionId: string; code: string }
  | ({ type: 'CAPTURE_READY' } & AutonomousTurnIdentity)
  | ({ type: 'CAPTURE_START_FAILED'; code: string; recoverable: boolean } & AutonomousTurnIdentity)
  | ({ type: 'ACTIVITY_OBSERVED'; state: 'listening' | 'speech'; levelDbfs: number } & AutonomousTurnIdentity)
  | ({ type: 'SPEECH_CONFIRMED' } & AutonomousTurnIdentity)
  | ({ type: 'SPEECH_ENDED' } & AutonomousTurnIdentity)
  | ({ type: 'ENDPOINT_REACHED' } & AutonomousTurnIdentity)
  | ({ type: 'CAPTURE_DURATION_LIMIT_REACHED' } & AutonomousTurnIdentity)
  | ({ type: 'CAPTURE_DRAINED'; revision: number } & AutonomousTurnIdentity)
  | ({ type: 'CAPTURE_PROCESSING' } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPTION_SUCCEEDED'; revision: number; transcript: string } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPTION_EMPTY'; revision: number } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPTION_FAILED'; revision?: number; code: string; recoverable: boolean } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPTION_TIMED_OUT'; revision?: number } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPT_ACCEPTED'; revision: number; text: string } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPT_DISCARDED'; revision: number; reason: string } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPT_STOP_REQUESTED'; revision: number } & AutonomousTurnIdentity)
  | ({
      type: 'TRANSCRIPT_COMPOSITION_BUFFERED';
      revision: number;
      operation: 'open' | 'append';
    } & AutonomousTurnIdentity)
  | ({
      type: 'TRANSCRIPT_COMPOSITION_REJECTED';
      revision: number;
      operation: 'open' | 'append';
    } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPT_COMPOSITION_CANCELLED'; revision: number } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPT_COMPOSITION_EMPTY_SEND'; revision: number } & AutonomousTurnIdentity)
  | ({ type: 'TRANSCRIPT_COMPOSITION_SEND_REQUESTED'; revision: number; text: string } & AutonomousTurnIdentity)
  | ({ type: 'DELIVERY_SUCCEEDED'; revision: number } & AutonomousTurnIdentity)
  | ({ type: 'DELIVERY_FAILED'; revision: number; code: string } & AutonomousTurnIdentity)
  | ({ type: 'CANDIDATE_ACKNOWLEDGED'; revision: number } & AutonomousTurnIdentity)
  | ({ type: 'NEXT_TURN_READY'; captureId: string; turnId: string } & Pick<AutonomousTurnIdentity, 'sessionId'>)
  | { type: 'PLAYBACK_STARTED'; sessionId: string; playbackGeneration: number; referenceText?: string }
  | { type: 'PLAYBACK_ENDED'; sessionId: string; playbackGeneration: number }
  | ({
      type: 'BARGE_IN_EVIDENCE';
      playbackGeneration: number;
      evidence: NarrationBargeInEvidence;
    } & AutonomousTurnIdentity)
  | { type: 'TOGGLE_OFF_REQUESTED' }
  | { type: 'HARD_STOP_REQUESTED' }
  | { type: 'STOP_COMPLETED' }
  | { type: 'GRACEFUL_STOP_TIMED_OUT' }
  | { type: 'WORKER_EXHAUSTED'; code: string };

export type AutonomousVoiceEffect =
  | { type: 'effect.enable'; sessionId: string }
  /**
   * `composing` selects the shorter endpoint window while a draft collects, so a short
   * command can finalize as its own turn instead of arriving glued to the sentence
   * before it. The machine owns the state; the session resolves it to an interval.
   */
  | ({ type: 'effect.beginCapture'; composing: boolean } & AutonomousTurnIdentity)
  | ({ type: 'effect.cancelCapture' } & AutonomousTurnIdentity)
  | ({ type: 'effect.finalizeCapture'; reason: 'endpoint' | 'duration-limit' | 'toggle-off' } & AutonomousTurnIdentity)
  | ({
      type: 'effect.applyTranscriptPolicy';
      revision: number;
      transcript: string;
      narrationOverlapPromoted: boolean;
      compositionState: VoiceCompositionState;
    } & AutonomousTurnIdentity)
  | ({
      type: 'effect.deliver';
      revision: number;
      text: string;
      intent?: 'immediate' | 'queuedFollowUp';
    } & AutonomousTurnIdentity)
  | ({ type: 'effect.acknowledge'; revision: number; outcome: AutonomousCandidateOutcome } & AutonomousTurnIdentity)
  | { type: 'effect.prepareNextTurn'; sessionId: string }
  | {
      type: 'effect.setPlaybackGate';
      sessionId: string;
      playbackGeneration: number;
      active: boolean;
      referenceText?: string;
    }
  | ({
      type: 'effect.confirmBargeIn';
      playbackGeneration: number;
      outcome: 'promote' | 'discard';
    } & AutonomousTurnIdentity)
  | { type: 'effect.abortPlayback' }
  | { type: 'effect.stop'; sessionId?: string; mode: 'graceful' | 'hard' }
  | { type: 'effect.reportFailure'; failure: AutonomousVoiceFailure };

function initialContext(): AutonomousVoiceContext {
  return {
    confirmedSpeech: false,
    narrationOverlapPromoted: false,
    stopRequested: false,
    hardStopRequested: false,
    playbackGeneration: 0,
    compositionState: 'inactive',
  };
}

function currentIdentity(context: AutonomousVoiceContext): AutonomousTurnIdentity | undefined {
  if (!context.sessionId || !context.captureId || !context.turnId) return undefined;
  return { sessionId: context.sessionId, captureId: context.captureId, turnId: context.turnId };
}

function requiredIdentity(context: AutonomousVoiceContext): AutonomousTurnIdentity {
  const identity = currentIdentity(context);
  if (!identity) throw new Error('Autonomous voice effect requires a current turn identity.');
  return identity;
}

function hasCaptureIdentity(event: AutonomousVoiceEvent): event is AutonomousVoiceEvent & CaptureIdentityEvent {
  return 'sessionId' in event && 'captureId' in event && 'turnId' in event;
}

function hasRevision(event: AutonomousVoiceEvent): event is AutonomousVoiceEvent & RevisionEvent {
  return hasCaptureIdentity(event) && 'revision' in event && typeof event.revision === 'number';
}

export const autonomousVoiceMachine = setup({
  types: {
    context: {} as AutonomousVoiceContext,
    events: {} as AutonomousVoiceEvent,
    emitted: {} as AutonomousVoiceEffect,
  },
  guards: {
    isCurrentSession: ({ context, event }) => 'sessionId' in event && event.sessionId === context.sessionId,
    isCurrentCapture: ({ context, event }) => {
      if (!hasCaptureIdentity(event)) return false;
      return (
        event.sessionId === context.sessionId &&
        event.captureId === context.captureId &&
        event.turnId === context.turnId
      );
    },
    isCurrentRevision: ({ context, event }) => {
      if (!hasRevision(event)) return false;
      return (
        event.sessionId === context.sessionId &&
        event.captureId === context.captureId &&
        event.turnId === context.turnId &&
        (context.revision === undefined || event.revision === context.revision)
      );
    },
    isCurrentPlayback: ({ context, event }) =>
      (event.type === 'PLAYBACK_STARTED' || event.type === 'PLAYBACK_ENDED') &&
      event.sessionId === context.sessionId &&
      event.playbackGeneration === context.playbackGeneration,
    isNewPlayback: ({ context, event }) =>
      event.type === 'PLAYBACK_STARTED' &&
      event.sessionId === context.sessionId &&
      event.playbackGeneration > context.playbackGeneration,
    isExactCurrentBargeInCommand: ({ context, event }) =>
      event.type === 'BARGE_IN_EVIDENCE' &&
      event.sessionId === context.sessionId &&
      event.captureId === context.captureId &&
      event.turnId === context.turnId &&
      event.playbackGeneration === context.playbackGeneration &&
      event.evidence.exactStopCommand,
    isActionableCurrentBargeIn: ({ context, event }) =>
      event.type === 'BARGE_IN_EVIDENCE' &&
      event.sessionId === context.sessionId &&
      event.captureId === context.captureId &&
      event.turnId === context.turnId &&
      event.playbackGeneration === context.playbackGeneration &&
      !event.evidence.exactStopCommand &&
      narrationBargeInIsActionable(event.evidence),
    stopWasRequested: ({ context }) => context.stopRequested,
    stopWasNotRequested: ({ context }) => !context.stopRequested,
  },
  actions: {
    cancelGracefulStopDeadline: cancel(GRACEFUL_STOP_TIMER_ID),
    scheduleGracefulStopDeadline: raise(
      { type: 'GRACEFUL_STOP_TIMED_OUT' },
      { delay: GRACEFUL_STOP_TIMEOUT_MS, id: GRACEFUL_STOP_TIMER_ID },
    ),
    clearSession: assign(() => initialContext()),
    assignSession: assign(({ event }) => {
      if (event.type !== 'ENABLE_REQUESTED') return {};
      return { ...initialContext(), sessionId: event.sessionId };
    }),
    assignFirstTurn: assign(({ event }) => {
      if (event.type !== 'ENABLE_SUCCEEDED') return {};
      return {
        captureId: event.captureId,
        turnId: event.turnId,
        revision: undefined,
        candidateOutcome: undefined,
        confirmedSpeech: false,
        narrationOverlapPromoted: false,
        failure: undefined,
      };
    }),
    assignNextTurn: assign(({ event }) => {
      if (event.type !== 'NEXT_TURN_READY') return {};
      return {
        captureId: event.captureId,
        turnId: event.turnId,
        revision: undefined,
        candidateOutcome: undefined,
        confirmedSpeech: false,
        narrationOverlapPromoted: false,
        failure: undefined,
      };
    }),
    markSpeech: assign({ confirmedSpeech: true }),
    markNarrationOverlapPromoted: assign({ narrationOverlapPromoted: true }),
    assignRevision: assign(({ event }) => (hasRevision(event) ? { revision: event.revision } : {})),
    markCommitted: assign({ candidateOutcome: 'committed' as const }),
    markDiscarded: assign({ candidateOutcome: 'discarded' as const }),
    markCompositionCollecting: assign({ compositionState: 'collecting' as const }),
    markCompositionSubmitting: assign({ compositionState: 'submitting' as const }),
    clearComposition: assign({ compositionState: 'inactive' as const }),
    resumeCompositionAfterFailure: assign(({ context }) =>
      context.compositionState === 'submitting' ? { compositionState: 'collecting' as const } : {},
    ),
    markStopRequested: assign({ stopRequested: true }),
    markHardStopRequested: assign({ stopRequested: true, hardStopRequested: true }),
    assignFailure: assign(({ event }) => {
      if ('code' in event && typeof event.code === 'string') {
        return {
          failure: {
            code: event.code,
            recoverable: 'recoverable' in event && event.recoverable === true,
          },
        };
      }
      if (event.type === 'TRANSCRIPTION_TIMED_OUT')
        return { failure: { code: 'transcription_timed_out', recoverable: true } };
      if (event.type === 'GRACEFUL_STOP_TIMED_OUT')
        return { failure: { code: 'graceful_stop_timed_out', recoverable: false } };
      return { failure: { code: GENERIC_FAILURE_CODE, recoverable: false } };
    }),
    assignPlaybackGeneration: assign(({ event }) =>
      event.type === 'PLAYBACK_STARTED' ? { playbackGeneration: event.playbackGeneration } : {},
    ),
    requestEnable: emit(({ context }) => {
      if (!context.sessionId) throw new Error('Autonomous voice enable requires a session identity.');
      return { type: 'effect.enable', sessionId: context.sessionId };
    }),
    requestCapture: emit(({ context }) => ({
      type: 'effect.beginCapture',
      ...requiredIdentity(context),
      composing: context.compositionState === 'collecting',
    })),
    requestCaptureCancellation: emit(({ context }) => ({
      type: 'effect.cancelCapture',
      ...requiredIdentity(context),
    })),
    requestEndpointFinalize: emit(({ context }) => ({
      type: 'effect.finalizeCapture',
      ...requiredIdentity(context),
      reason: 'endpoint',
    })),
    requestDurationFinalize: emit(({ context }) => ({
      type: 'effect.finalizeCapture',
      ...requiredIdentity(context),
      reason: 'duration-limit',
    })),
    requestStopFinalize: emit(({ context }) => ({
      type: 'effect.finalizeCapture',
      ...requiredIdentity(context),
      reason: 'toggle-off',
    })),
    requestTranscriptPolicy: emit(({ context, event }) => {
      if (event.type !== 'TRANSCRIPTION_SUCCEEDED')
        throw new Error('Transcript policy requires a successful transcription event.');
      return {
        type: 'effect.applyTranscriptPolicy',
        sessionId: event.sessionId,
        captureId: event.captureId,
        turnId: event.turnId,
        revision: event.revision,
        transcript: event.transcript,
        narrationOverlapPromoted: context.narrationOverlapPromoted,
        compositionState: context.compositionState,
      };
    }),
    requestDelivery: emit(({ event }) => {
      if (event.type !== 'TRANSCRIPT_ACCEPTED') throw new Error('Voice delivery requires an accepted transcript.');
      return {
        type: 'effect.deliver',
        sessionId: event.sessionId,
        captureId: event.captureId,
        turnId: event.turnId,
        revision: event.revision,
        text: event.text,
      };
    }),
    requestCompositionDelivery: emit(({ event }) => {
      if (event.type !== 'TRANSCRIPT_COMPOSITION_SEND_REQUESTED')
        throw new Error('Voice composition delivery requires a send request.');
      return {
        type: 'effect.deliver',
        sessionId: event.sessionId,
        captureId: event.captureId,
        turnId: event.turnId,
        revision: event.revision,
        text: event.text,
        intent: 'queuedFollowUp' as const,
      };
    }),
    requestAcknowledgement: emit(({ context }) => {
      if (context.revision === undefined || !context.candidateOutcome)
        throw new Error('Autonomous voice acknowledgement requires a revision and outcome.');
      return {
        type: 'effect.acknowledge',
        ...requiredIdentity(context),
        revision: context.revision,
        outcome: context.candidateOutcome,
      };
    }),
    requestNextTurn: emit(({ context }) => {
      if (!context.sessionId) throw new Error('Autonomous voice next turn requires a session identity.');
      return { type: 'effect.prepareNextTurn', sessionId: context.sessionId };
    }),
    openPlaybackGate: emit(({ event }) => {
      if (event.type !== 'PLAYBACK_STARTED') throw new Error('Playback start effect requires a playback event.');
      return {
        type: 'effect.setPlaybackGate',
        sessionId: event.sessionId,
        playbackGeneration: event.playbackGeneration,
        active: true,
        ...(event.referenceText ? { referenceText: event.referenceText } : {}),
      };
    }),
    closePlaybackGate: emit(({ event }) => {
      if (event.type !== 'PLAYBACK_ENDED') throw new Error('Playback end effect requires a playback event.');
      return {
        type: 'effect.setPlaybackGate',
        sessionId: event.sessionId,
        playbackGeneration: event.playbackGeneration,
        active: false,
      };
    }),
    requestBargeInPromotion: emit(({ event }) => {
      if (event.type !== 'BARGE_IN_EVIDENCE') throw new Error('Barge-in promotion requires ranked evidence.');
      return {
        type: 'effect.confirmBargeIn',
        sessionId: event.sessionId,
        captureId: event.captureId,
        turnId: event.turnId,
        playbackGeneration: event.playbackGeneration,
        outcome: event.evidence.exactStopCommand ? 'discard' : 'promote',
      };
    }),
    requestPlaybackAbort: emit({ type: 'effect.abortPlayback' }),
    requestStop: emit(({ context }) => ({
      type: 'effect.stop',
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      mode: context.hardStopRequested ? 'hard' : 'graceful',
    })),
    requestHardStop: emit(({ context }) => ({
      type: 'effect.stop',
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      mode: 'hard',
    })),
    reportFailure: emit(({ context }) => ({
      type: 'effect.reportFailure',
      failure: context.failure ?? { code: GENERIC_FAILURE_CODE, recoverable: false },
    })),
  },
}).createMachine({
  id: 'autonomousVoice',
  initial: 'off',
  context: initialContext(),
  states: {
    off: {
      entry: ['cancelGracefulStopDeadline', 'clearSession'],
      on: {
        ENABLE_REQUESTED: {
          target: 'enabling',
          actions: 'assignSession',
        },
        HARD_STOP_REQUESTED: {},
        TOGGLE_OFF_REQUESTED: {},
      },
    },
    enabling: {
      entry: 'requestEnable',
      on: {
        ENABLE_SUCCEEDED: {
          guard: 'isCurrentSession',
          target: 'active',
          actions: 'assignFirstTurn',
        },
        ENABLE_FAILED: {
          guard: 'isCurrentSession',
          target: 'failed',
          actions: 'assignFailure',
        },
        TOGGLE_OFF_REQUESTED: {
          target: 'stopping',
          actions: ['markStopRequested', 'scheduleGracefulStopDeadline'],
        },
        HARD_STOP_REQUESTED: {
          target: 'stopping',
          actions: 'markHardStopRequested',
        },
      },
    },
    active: {
      type: 'parallel',
      on: {
        TOGGLE_OFF_REQUESTED: {
          target: 'stopping',
          actions: ['markStopRequested', 'scheduleGracefulStopDeadline', 'requestPlaybackAbort'],
        },
        GRACEFUL_STOP_TIMED_OUT: {
          target: 'stopping',
          actions: ['markHardStopRequested', 'assignFailure', 'reportFailure'],
        },
        HARD_STOP_REQUESTED: {
          target: 'stopping',
          actions: ['markHardStopRequested', 'requestPlaybackAbort'],
        },
        WORKER_EXHAUSTED: {
          target: 'failed',
          actions: 'assignFailure',
        },
      },
      states: {
        capture: {
          initial: 'startingCapture',
          states: {
            startingCapture: {
              entry: 'requestCapture',
              on: {
                CAPTURE_READY: { guard: 'isCurrentCapture', target: 'listening' },
                CAPTURE_START_FAILED: {
                  guard: 'isCurrentCapture',
                  target: '#autonomousVoice.failed',
                  actions: 'assignFailure',
                },
              },
            },
            listening: {
              on: {
                SPEECH_CONFIRMED: {
                  guard: 'isCurrentCapture',
                  target: 'speech',
                  actions: 'markSpeech',
                },
                CAPTURE_DURATION_LIMIT_REACHED: {
                  guard: 'isCurrentCapture',
                  target: 'startingNextTurn',
                  actions: 'requestCaptureCancellation',
                },
                BARGE_IN_EVIDENCE: [
                  {
                    guard: 'isExactCurrentBargeInCommand',
                    actions: ['requestBargeInPromotion', 'requestPlaybackAbort'],
                  },
                  {
                    guard: 'isActionableCurrentBargeIn',
                    target: 'speech',
                    actions: [
                      'markSpeech',
                      'markNarrationOverlapPromoted',
                      'requestBargeInPromotion',
                      'requestPlaybackAbort',
                    ],
                  },
                ],
              },
            },
            speech: {
              on: {
                BARGE_IN_EVIDENCE: [
                  {
                    guard: 'isExactCurrentBargeInCommand',
                    actions: ['requestBargeInPromotion', 'requestPlaybackAbort'],
                  },
                  {
                    guard: 'isActionableCurrentBargeIn',
                    actions: ['markNarrationOverlapPromoted', 'requestBargeInPromotion', 'requestPlaybackAbort'],
                  },
                ],
                ENDPOINT_REACHED: {
                  guard: 'isCurrentCapture',
                  target: 'finalizing',
                  actions: 'requestEndpointFinalize',
                },
                CAPTURE_DURATION_LIMIT_REACHED: {
                  guard: 'isCurrentCapture',
                  target: 'finalizing',
                  actions: 'requestDurationFinalize',
                },
                TOGGLE_OFF_REQUESTED: {
                  target: 'finalizing',
                  actions: [
                    'markStopRequested',
                    'scheduleGracefulStopDeadline',
                    'requestPlaybackAbort',
                    'requestStopFinalize',
                  ],
                },
              },
            },
            finalizing: {
              on: {
                CAPTURE_DRAINED: {
                  guard: 'isCurrentCapture',
                  target: 'transcribing',
                  actions: 'assignRevision',
                },
                CAPTURE_PROCESSING: {
                  guard: 'isCurrentCapture',
                  target: 'transcribing',
                },
                TOGGLE_OFF_REQUESTED: [
                  {
                    guard: 'stopWasNotRequested',
                    actions: ['markStopRequested', 'scheduleGracefulStopDeadline', 'requestPlaybackAbort'],
                  },
                  {},
                ],
              },
            },
            transcribing: {
              on: {
                TRANSCRIPTION_SUCCEEDED: {
                  guard: 'isCurrentCapture',
                  target: 'applyingPolicy',
                  actions: ['assignRevision', 'requestTranscriptPolicy'],
                },
                TRANSCRIPTION_EMPTY: {
                  guard: 'isCurrentRevision',
                  target: 'acknowledging',
                  actions: ['assignRevision', 'markDiscarded'],
                },
                TRANSCRIPTION_FAILED: {
                  guard: 'isCurrentCapture',
                  target: '#autonomousVoice.failed',
                  actions: 'assignFailure',
                },
                TRANSCRIPTION_TIMED_OUT: {
                  guard: 'isCurrentCapture',
                  target: '#autonomousVoice.failed',
                  actions: 'assignFailure',
                },
                TOGGLE_OFF_REQUESTED: [
                  {
                    guard: 'stopWasNotRequested',
                    actions: ['markStopRequested', 'scheduleGracefulStopDeadline', 'requestPlaybackAbort'],
                  },
                  {},
                ],
              },
            },
            applyingPolicy: {
              on: {
                TRANSCRIPT_ACCEPTED: {
                  guard: 'isCurrentRevision',
                  target: 'delivering',
                  actions: ['markCommitted', 'requestDelivery'],
                },
                TRANSCRIPT_DISCARDED: {
                  guard: 'isCurrentRevision',
                  target: 'acknowledging',
                  actions: 'markDiscarded',
                },
                TRANSCRIPT_STOP_REQUESTED: {
                  guard: 'isCurrentRevision',
                  target: 'acknowledging',
                  actions: ['markStopRequested', 'scheduleGracefulStopDeadline', 'markDiscarded'],
                },
                TRANSCRIPT_COMPOSITION_BUFFERED: {
                  guard: 'isCurrentRevision',
                  target: 'acknowledging',
                  actions: ['markCompositionCollecting', 'markCommitted'],
                },
                TRANSCRIPT_COMPOSITION_REJECTED: {
                  guard: 'isCurrentRevision',
                  target: 'acknowledging',
                  actions: ['markCompositionCollecting', 'markDiscarded'],
                },
                TRANSCRIPT_COMPOSITION_CANCELLED: {
                  guard: 'isCurrentRevision',
                  target: 'acknowledging',
                  actions: ['clearComposition', 'markDiscarded'],
                },
                TRANSCRIPT_COMPOSITION_EMPTY_SEND: {
                  guard: 'isCurrentRevision',
                  target: 'acknowledging',
                  actions: 'markDiscarded',
                },
                TRANSCRIPT_COMPOSITION_SEND_REQUESTED: {
                  guard: 'isCurrentRevision',
                  target: 'delivering',
                  actions: ['markCompositionSubmitting', 'requestCompositionDelivery'],
                },
                TOGGLE_OFF_REQUESTED: [
                  {
                    guard: 'stopWasNotRequested',
                    actions: ['markStopRequested', 'scheduleGracefulStopDeadline', 'requestPlaybackAbort'],
                  },
                  {},
                ],
              },
            },
            delivering: {
              on: {
                DELIVERY_SUCCEEDED: {
                  guard: 'isCurrentRevision',
                  target: 'acknowledging',
                  actions: ['markCommitted', 'clearComposition'],
                },
                DELIVERY_FAILED: {
                  guard: 'isCurrentRevision',
                  target: 'acknowledging',
                  actions: ['assignFailure', 'reportFailure', 'markDiscarded', 'resumeCompositionAfterFailure'],
                },
                TOGGLE_OFF_REQUESTED: [
                  {
                    guard: 'stopWasNotRequested',
                    actions: ['markStopRequested', 'scheduleGracefulStopDeadline', 'requestPlaybackAbort'],
                  },
                  {},
                ],
              },
            },
            acknowledging: {
              entry: 'requestAcknowledgement',
              on: {
                CANDIDATE_ACKNOWLEDGED: [
                  {
                    guard: ({ context, event }) =>
                      event.sessionId === context.sessionId &&
                      event.captureId === context.captureId &&
                      event.turnId === context.turnId &&
                      event.revision === context.revision &&
                      context.stopRequested,
                    target: '#autonomousVoice.stopping',
                  },
                  {
                    guard: 'isCurrentRevision',
                    target: 'startingNextTurn',
                  },
                ],
                TOGGLE_OFF_REQUESTED: [
                  {
                    guard: 'stopWasNotRequested',
                    actions: ['markStopRequested', 'scheduleGracefulStopDeadline', 'requestPlaybackAbort'],
                  },
                  {},
                ],
              },
            },
            startingNextTurn: {
              entry: 'requestNextTurn',
              on: {
                NEXT_TURN_READY: {
                  guard: 'isCurrentSession',
                  target: 'startingCapture',
                  actions: 'assignNextTurn',
                },
              },
            },
          },
        },
        playback: {
          initial: 'silent',
          states: {
            silent: {
              on: {
                PLAYBACK_STARTED: {
                  guard: 'isNewPlayback',
                  target: 'playing',
                  actions: ['assignPlaybackGeneration', 'openPlaybackGate'],
                },
              },
            },
            playing: {
              on: {
                PLAYBACK_STARTED: {
                  guard: 'isNewPlayback',
                  actions: ['assignPlaybackGeneration', 'openPlaybackGate'],
                },
                PLAYBACK_ENDED: {
                  guard: 'isCurrentPlayback',
                  target: 'echoTail',
                  actions: 'closePlaybackGate',
                },
              },
            },
            echoTail: {
              after: {
                [PLAYBACK_ECHO_TAIL_MS]: { target: 'silent' },
              },
              on: {
                PLAYBACK_STARTED: {
                  guard: 'isNewPlayback',
                  target: 'playing',
                  actions: ['assignPlaybackGeneration', 'openPlaybackGate'],
                },
              },
            },
          },
        },
      },
    },
    stopping: {
      entry: 'requestStop',
      on: {
        STOP_COMPLETED: { target: 'off' },
        HARD_STOP_REQUESTED: {
          actions: ['markHardStopRequested', 'requestHardStop'],
        },
        GRACEFUL_STOP_TIMED_OUT: {
          actions: ['markHardStopRequested', 'assignFailure', 'reportFailure', 'requestHardStop'],
        },
      },
    },
    failed: {
      entry: ['reportFailure', 'requestHardStop'],
      on: {
        STOP_COMPLETED: { target: 'off' },
        HARD_STOP_REQUESTED: { actions: 'requestHardStop' },
      },
      after: {
        [GRACEFUL_STOP_TIMEOUT_MS]: { target: 'off' },
      },
    },
  },
});

export type AutonomousVoiceSnapshot = SnapshotFrom<typeof autonomousVoiceMachine>;

export function autonomousVoiceState(
  snapshot: AutonomousVoiceSnapshot,
): 'off' | 'starting' | 'listening' | 'speech' | 'processing' | 'stopping' | 'failed' {
  if (snapshot.matches('off')) return 'off';
  if (snapshot.matches('enabling') || snapshot.matches({ active: { capture: 'startingCapture' } })) return 'starting';
  if (snapshot.matches({ active: { capture: 'listening' } })) return 'listening';
  if (snapshot.matches({ active: { capture: 'speech' } })) return 'speech';
  if (snapshot.matches('stopping')) return 'stopping';
  if (snapshot.matches('failed')) return 'failed';
  return 'processing';
}
