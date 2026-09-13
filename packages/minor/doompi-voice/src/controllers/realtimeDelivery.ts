import { REALTIME_LIMITS, type RealtimeDeliveryOutcome, type RealtimeEvent } from '../types/realtime';

export interface RealtimeDeliveryOptions {
  activationId: string;
  isOwned(activationId: string): boolean;
  isBusy(): boolean;
  isBlocked(): boolean;
  send(text: string, intent: 'immediate' | 'follow-up'): void | Promise<void>;
}

export interface RealtimeDeliveryRequest {
  requestId: string;
  text: string;
}

interface ObservedRequest extends RealtimeDeliveryRequest {
  authorizedText?: string;
}

interface RetainedDelivery {
  text: string;
  outcome: RealtimeDeliveryOutcome;
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= REALTIME_LIMITS.identifierCharacters;
}

function validText(value: string): boolean {
  return value.trim().length > 0 && value.length <= REALTIME_LIMITS.textCharacters;
}

/**
 * Bridges one realtime activation to Pi user-message delivery without treating companion
 * output as authority. A source-backed delegation is dispatchable only after it is paired
 * with one fresh finalized user transcript. The finalized transcript, never the companion
 * reformulation, is the text sent to Pi.
 */
export class RealtimeDelivery {
  private readonly retained = new Map<string, RetainedDelivery>();
  private pending: ObservedRequest | undefined;
  private freshUserText: string | undefined;
  private dispatching = false;

  public constructor(private readonly options: RealtimeDeliveryOptions) {}

  public observe(event: RealtimeEvent): void {
    if (!this.options.isOwned(this.options.activationId)) return;
    if (event.type === 'transcript' && event.role === 'user' && event.complete && validText(event.text)) {
      if (this.pending && this.pending.authorizedText === undefined) {
        this.pending.authorizedText = event.text;
      } else if (!this.pending) {
        this.freshUserText = event.text;
      }
      return;
    }
    if (event.type !== 'request' || !validIdentifier(event.requestId) || !validText(event.text)) return;

    const retained = this.retained.get(event.requestId);
    if (retained || this.pending || this.retained.size >= REALTIME_LIMITS.retainedRequests) return;
    this.pending = {
      requestId: event.requestId,
      text: event.text,
      ...(this.freshUserText === undefined ? {} : { authorizedText: this.consumeFreshUserText() }),
    };
  }

  public submit(request: RealtimeDeliveryRequest): RealtimeDeliveryOutcome | Promise<RealtimeDeliveryOutcome> {
    if (
      !this.options.isOwned(this.options.activationId) ||
      !validIdentifier(request.requestId) ||
      !validText(request.text)
    )
      return 'rejected';

    const retained = this.retained.get(request.requestId);
    if (retained) return retained.text === request.text ? retained.outcome : 'rejected';

    const pending = this.pending;
    if (!pending) return 'rejected';
    if (pending.requestId !== request.requestId) return 'busy';
    if (pending.text !== request.text) return 'rejected';
    if (pending.authorizedText === undefined) return 'busy';
    if (this.retained.size >= REALTIME_LIMITS.retainedRequests) return 'rejected';
    if (this.dispatching) {
      this.retain(request, 'busy');
      this.pending = undefined;
      return 'busy';
    }

    if (this.options.isBlocked()) {
      this.pending = undefined;
      this.retain(request, 'rejected');
      return 'rejected';
    }

    this.pending = undefined;
    this.dispatching = true;
    let outcome: RealtimeDeliveryOutcome;
    let asynchronous = false;
    try {
      const admission = this.options.send(pending.authorizedText, 'immediate');
      if (admission) {
        asynchronous = true;
        return admission
          .then(
            () => {
              const outcome = this.options.isOwned(this.options.activationId) ? 'submitted' : 'uncertain';
              this.retain(request, outcome);
              return outcome;
            },
            () => {
              this.retain(request, 'uncertain');
              return 'uncertain' as const;
            },
          )
          .finally(() => {
            this.dispatching = false;
          });
      }
      outcome = this.options.isOwned(this.options.activationId) ? 'submitted' : 'uncertain';
    } catch {
      outcome = 'uncertain';
    } finally {
      if (!asynchronous) this.dispatching = false;
    }
    this.retain(request, outcome);
    return outcome;
  }

  public retire(request: RealtimeDeliveryRequest): RealtimeDeliveryOutcome {
    const pending = this.pending;
    if (!pending || pending.requestId !== request.requestId || pending.text !== request.text) return 'rejected';
    this.pending = undefined;
    this.retain(request, 'rejected');
    return 'rejected';
  }
  private consumeFreshUserText(): string {
    const text = this.freshUserText!;
    this.freshUserText = undefined;
    return text;
  }

  private retain(request: RealtimeDeliveryRequest, outcome: RealtimeDeliveryOutcome): void {
    this.retained.set(request.requestId, { text: request.text, outcome });
  }
}
