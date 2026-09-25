import { createHash, randomUUID } from 'node:crypto';

import type { DoomApi } from '@agimon-ai/doompi-core/packageApi';
import { parseRemoteSessionReference } from '@agimon-ai/doompi-session';

import type { AutoCaptureUi } from '../../types';
import type { RealtimeDeliveryOutcome } from '../../types/realtime';
import { VoiceMediaBroker } from '../clientMediaApi';
import { SystemClock } from '../infrastructure';
import { LiveVoiceController } from '../liveVoiceController';
import { buildDelegationResultMessages } from '../realtimeProtocol';
import type { VoiceOwnershipCoordinator } from '../voiceOwnershipCoordinator';
import { requestPairedVoiceAgent } from '../voicePeerRelay';
import type {
  GlobalLiveAgentHost,
  GlobalLiveControl,
  GlobalLiveNativeTransfer,
  GlobalLiveReceipts,
  GlobalLiveStatus,
  LiveAgentResult,
  LiveAgentResults,
  LiveAgentRoute,
} from './type';

const AGENT_BASE_PATH = 'voice';
const AGENT_READINESS = '/live/agent';
const AGENT_PREPARE = '/live/agent/prepare';
const AGENT_ADMIT = '/live/agent/admit';
const AGENT_RESULTS = '/live/agent/results';
const AGENT_ACK = '/live/agent/results/ack';
const AGENT_FENCE = '/live/agent/fence';
const AGENT_SELECT = '/live/agent/select';
const AGENT_REVOKE = '/live/agent/revoke';
const POLL_MS = 250;
const MAX_HELD = 16;
const MAX_HELD_BYTES = 64 * 1024;
const ADMISSION_NAMESPACE = 'voice.admission';
const PUBLICATION_NAMESPACE = 'voice.publication';

interface HeldRequest {
  requestId: string;
  transcript: string;
  transactionId: string;
  destination: string;
}

interface Transfer {
  source: LiveAgentRoute;
  targetSessionId: string;
  transactionId: string;
  target?: LiveAgentRoute;
  held: HeldRequest[];
  heldBytes: number;
  failure?: string;
}

export interface GlobalLiveCompanionOptions {
  broker: VoiceMediaBroker;
  receipts?: GlobalLiveReceipts;
  homeDirectory?: string;
  onNotice(message: string): void;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The activation, browser lease and provider live on this host, independently of selected Pi sessions. */
export class GlobalLiveCompanion {
  private hub: GlobalLiveAgentHost | undefined;
  private route: LiveAgentRoute | undefined;
  private transfer: Transfer | undefined;
  private activationId: string | undefined;
  private routeGeneration = 0;
  private stopped = false;
  private polling = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private error: string | undefined;
  private readonly admitted = new Map<string, LiveAgentRoute>();
  private coordinator: VoiceOwnershipCoordinator | undefined;
  private nativeTransferPending = false;
  private selecting: Promise<void> = Promise.resolve();
  private selectedRoute: LiveAgentRoute | undefined;
  private activationSelection: { route: LiveAgentRoute; promise: Promise<void>; resolve(): void } | undefined;
  private readonly clock = new SystemClock();
  private readonly ui: AutoCaptureUi;
  private readonly live: LiveVoiceController;

  public constructor(private readonly options: GlobalLiveCompanionOptions) {
    this.ui = {
      notify: (message) => options.onNotice(message),
      setIndicator: () => undefined,
      setStatus: () => undefined,
    };
    this.live = new LiveVoiceController({
      host: options.broker.live,
      clock: this.clock,
      manualState: () => 'idle',
      contextText: () =>
        this.route === undefined
          ? 'There is no active Pi agent. Do not delegate work.'
          : `Active Pi agent session: ${this.route.scope.sessionId}. Workspace: ${this.route.scope.cwd}.`,
      isBusy: () => this.admitted.size > 0,
      send: () => {
        throw new Error('Live voice requires a correlated, receipt-backed agent request.');
      },
      sendRequest: (requestId, transcript) => this.admit(requestId, transcript),
      durableReplay: options.receipts !== undefined,
      createId: () => this.activationId ?? randomUUID(),
      onActivationStateChange: (state) => {
        if (state === 'active') {
          const route = this.route;
          if (route && !this.transfer) {
            const pending = this.activationSelection;
            void this.selectRoute(route)
              .catch((error: unknown) =>
                this.options.onNotice(`Global Voice route selection failed: ${errorMessage(error)}`),
              )
              .finally(() => {
                if (this.activationSelection === pending) this.activationSelection = undefined;
                pending?.resolve();
              });
          }
        }
        if (state === 'disabled') {
          this.stopPolling();
          this.route = undefined;
          this.selectedRoute = undefined;
          this.activationSelection?.resolve();
          this.activationSelection = undefined;
          if (this.transfer?.held.length) {
            this.error = `Global Voice disconnected with ${this.transfer.held.length} held requests for ${this.transfer.targetSessionId}; they were not admitted.`;
            this.options.onNotice(this.error);
          } else this.transfer = undefined;
          this.admitted.clear();
          this.activationId = undefined;
        }
      },
    });
  }

  public setCatalog(coordinator: VoiceOwnershipCoordinator | undefined): void {
    this.coordinator = coordinator;
    if (coordinator)
      void this.refreshSelectedCatalog().catch((error: unknown) =>
        this.options.onNotice(`Global Voice catalog update failed: ${errorMessage(error)}`),
      );
  }

  public async refreshSelectedCatalog(): Promise<void> {
    const route = this.route;
    if (route && this.live.state === 'active' && !this.transfer) await this.selectRoute(route);
  }

  public bind(host: GlobalLiveAgentHost): void {
    if (this.hub && this.hub !== host) throw new Error('Global Voice already has a hub owner.');
    this.hub = host;
  }

  public unbind(host: GlobalLiveAgentHost): void {
    if (this.hub === host) {
      this.hub = undefined;
      void this.stop().catch((error: unknown) =>
        this.options.onNotice(`Global Voice shutdown failed: ${errorMessage(error)}`),
      );
    }
  }

  public get status(): GlobalLiveStatus {
    return {
      version: 1,
      state: this.live.state,
      activeSessionId: this.route?.scope.sessionId ?? null,
      muted: this.live.microphoneMuted,
      ...((this.error ?? this.live.activationError) ? { error: this.error ?? this.live.activationError } : {}),
      media: { client: this.options.broker.browserConnected, realtime: this.options.broker.realtimeActive },
    };
  }

  public mediaReady(): boolean {
    return this.route !== undefined && !this.stopped && this.live.state !== 'disabled';
  }

  public async control(input: GlobalLiveControl): Promise<GlobalLiveStatus> {
    if (input.expectedSourceSessionId !== undefined && this.route?.scope.sessionId !== input.expectedSourceSessionId)
      throw new Error('The native session no longer owns the live Voice route.');
    switch (input.action) {
      case 'activate':
        if (!input.sessionId) throw new Error('Select an admitted Pi session to start live voice.');
        await this.activate(input.sessionId);
        break;
      case 'transfer':
        if (!input.sessionId || !this.route) throw new Error('Select an admitted Pi session for live Voice transfer.');
        if (input.sessionId === this.route.scope.sessionId) break;
        if (!(await this.handoff(this.route.scope.sessionId, input.sessionId, randomUUID())))
          throw new Error(this.error ?? 'Live Voice transfer was rejected.');
        break;
      case 'end':
        await this.stop();
        break;
      case 'mute':
      case 'unmute':
        if (this.live.state === 'disabled') throw new Error('Live voice is not active.');
        this.live.setMicrophoneMuted(input.action === 'mute');
        break;
      case 'interrupt':
        if (this.live.state === 'disabled') throw new Error('Live voice is not active.');
        this.live.interruptSpeech();
        break;
    }
    return this.status;
  }

  /** Route identity is checked both before and after target resolution, and again by handoff. */
  public nativeTransfer(
    input: GlobalLiveNativeTransfer,
    resolve: (sourceSessionId: string, ordinal: number, revision: string) => string | undefined,
  ): { requested: true } {
    const matches = () =>
      this.route?.scope.sessionId === input.sourceSessionId &&
      this.route.activationId === input.activationId &&
      this.route.generation === input.routeGeneration &&
      this.route.sessionIncarnation === input.sessionIncarnation &&
      this.live.state === 'active' &&
      this.transfer === undefined &&
      !this.nativeTransferPending;
    if (!matches()) throw new Error('The native session no longer owns the live Voice route.');
    const target = resolve(input.sourceSessionId, input.ordinal, input.catalogRevision);
    if (!target || !matches() || target === input.sourceSessionId)
      throw new Error('The Voice transfer catalog or source route is stale.');
    this.nativeTransferPending = true;
    void this.handoff(input.sourceSessionId, target, randomUUID())
      .then((committed) => {
        if (!committed) this.options.onNotice(this.error ?? 'Live Voice transfer was rejected.');
      })
      .catch((error: unknown) => this.options.onNotice(`Live Voice transfer failed: ${errorMessage(error)}`))
      .finally(() => {
        this.nativeTransferPending = false;
      });
    return { requested: true };
  }

  public async activate(sessionId: string): Promise<void> {
    if (this.stopped) throw new Error('Global Voice service is closed.');
    if (this.live.state !== 'disabled') {
      if (this.route?.scope.sessionId === sessionId) return;
      throw new Error('Use a prepared Voice transfer rather than starting a second companion.');
    }
    if (this.transfer)
      throw new Error('Held Voice transfer requests require explicit cancellation before a new activation.');
    if (!this.options.receipts)
      throw new Error('Live Voice receipt storage is unavailable. No agent admission was attempted.');
    if (!this.options.broker.browserConnected) throw new Error('An authenticated browser media lease is required.');
    const activationId = randomUUID();
    const generation = ++this.routeGeneration;
    const route = await this.prepare(sessionId, activationId, generation, randomUUID());
    if (this.stopped || this.live.state !== 'disabled' || generation !== this.routeGeneration) return;
    this.activationId = activationId;
    this.route = route;
    this.error = undefined;
    let resolveSelection!: () => void;
    const selection = new Promise<void>((resolve) => {
      resolveSelection = resolve;
    });
    this.activationSelection = { route, promise: selection, resolve: resolveSelection };
    this.startPolling();
    await this.live.activate(this.ui);
  }

  /** A transfer changes the fenced agent adapter, never the activation, lease, or provider call. */
  public async handoff(sourceSessionId: string, targetSessionId: string, transactionId: string): Promise<boolean> {
    const source = this.route;
    if (!source || source.scope.sessionId !== sourceSessionId || this.transfer || this.live.state !== 'active')
      return false;
    const generation = ++this.routeGeneration;
    // Hold requests as soon as the transfer starts, including while the target prepares.
    const transfer: Transfer = { source, targetSessionId, transactionId, held: [], heldBytes: 0 };
    this.transfer = transfer;
    try {
      const target = await this.prepare(targetSessionId, source.activationId, generation, transactionId);
      if (this.stopped || this.route !== source || this.transfer !== transfer || this.live.state !== 'active')
        return false;
      transfer.target = target;
      while (this.route === source && this.transfer === transfer && !this.stopped) {
        const running = await this.pollAgentResults(source);
        if (this.admitted.size === 0 && !running) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      if (this.route !== source || this.transfer !== transfer || this.stopped) return false;
      // The target was prepared while the source was still authoritative. No media lifecycle runs here.
      this.selectedRoute = undefined;
      await this.agentRequest(source, AGENT_FENCE, 'POST', {
        activationId: source.activationId,
        routeGeneration: source.generation,
        transactionId: source.transactionId,
        sessionIncarnation: source.sessionIncarnation,
      });
      if (this.route !== source || this.transfer !== transfer || this.stopped) return false;
      await this.selectRoute(target);
      if (this.route !== source || this.transfer !== transfer || this.stopped) return false;
      this.route = target;
      for (const item of transfer.held) {
        if (this.transfer !== transfer || this.stopped) return false;
        const outcome = await this.admitToRoute(target, item.requestId, item.transcript);
        if (outcome !== 'submitted')
          throw new Error(`Held Voice request ${item.requestId} could not be admitted: ${outcome}.`);
        this.live.trackAgentRequest(item.requestId);
        await this.options.broker.live.send(
          target.activationId,
          buildDelegationResultMessages(item.requestId, 'submitted', 'commentary'),
          new AbortController().signal,
        );
      }
      this.transfer = undefined;
      this.error = undefined;
      return true;
    } catch (error) {
      transfer.failure = errorMessage(error);
      if (this.transfer === transfer && transfer.held.length === 0) this.transfer = undefined;
      this.error = `Voice transfer failed: ${transfer.failure}. ${transfer.held.length} held requests remain for ${targetSessionId}.`;
      this.options.onNotice(this.error);
      return false;
    }
  }

  public async stop(): Promise<void> {
    // Revoke route and pending work synchronously, before any media teardown await.
    if (this.transfer?.held.length)
      this.options.onNotice(
        `Explicit Voice stop discarded ${this.transfer.held.length} held requests for ${this.transfer.targetSessionId}.`,
      );
    const previousRoute = this.route;
    this.routeGeneration += 1;
    this.route = undefined;
    this.selectedRoute = undefined;
    this.activationSelection?.resolve();
    this.activationSelection = undefined;
    this.nativeTransferPending = false;
    this.transfer = undefined;
    this.admitted.clear();
    this.stopPolling();
    if (previousRoute) {
      await this.selecting.catch(() => undefined);
      await this.agentRequest(previousRoute, AGENT_REVOKE, 'POST', {
        activationId: previousRoute.activationId,
        routeGeneration: previousRoute.generation,
        transactionId: previousRoute.transactionId,
        sessionIncarnation: previousRoute.sessionIncarnation,
      }).catch((error: unknown) =>
        this.options.onNotice(`Global Voice route revocation failed: ${errorMessage(error)}`),
      );
    }
    await this.live.deactivate(this.ui);
    this.activationId = undefined;
  }

  public async close(): Promise<void> {
    this.stopped = true;
    await this.stop();
    this.options.broker.close();
    this.hub = undefined;
  }

  private selectRoute(route: LiveAgentRoute): Promise<void> {
    // Serialize catalog refreshes and selection against stop/route replacement. A stale ACK
    // must never authorize admission to a newly selected route.
    const run = this.selecting
      .catch(() => undefined)
      .then(async () => {
        if (this.stopped || (this.route !== route && this.transfer?.target !== route)) return;
        const catalog = this.coordinator?.liveCatalog(route.scope.sessionId) ?? {
          revision: 'catalog-unavailable',
          targets: [],
        };
        await this.agentRequest(route, AGENT_SELECT, 'POST', {
          catalog,
          // ponytail: Paired Pi tools stay hidden until the signed relay can carry transfer intents back to this owner host.
          nativeTransferAllowed: parseRemoteSessionReference(route.scope.sessionId) === undefined,
          activationId: route.activationId,
          routeGeneration: route.generation,
          transactionId: route.transactionId,
          sessionIncarnation: route.sessionIncarnation,
        });
        if (!this.stopped && (this.route === route || this.transfer?.target === route)) this.selectedRoute = route;
      });
    this.selecting = run;
    return run;
  }

  private async prepare(
    sessionId: string,
    activationId: string,
    generation: number,
    transactionId: string,
  ): Promise<LiveAgentRoute> {
    const hub = this.hub;
    const remote = parseRemoteSessionReference(sessionId);
    const scope = remote
      ? { sessionId, cwd: `peer/${remote.hostId}` }
      : hub?.sessions().find((candidate) => candidate.sessionId === sessionId);
    if (!hub || !scope || (remote && !this.options.homeDirectory))
      throw new Error('The selected native Pi agent is not available on this host.');
    const sourceSessionId = remote?.sessionId ?? sessionId;
    const readiness = object(await this.agentRequest({ scope }, AGENT_READINESS, 'GET'));
    if (
      readiness?.available !== true ||
      typeof readiness.sessionIncarnation !== 'string' ||
      readiness.sourceSessionId !== sourceSessionId
    )
      throw new Error('The selected Pi agent cannot accept live Voice requests.');
    const prepared = object(
      await this.agentRequest({ scope }, AGENT_PREPARE, 'POST', {
        activationId,
        routeGeneration: generation,
        transactionId,
      }),
    );
    if (
      prepared?.sourceSessionId !== sourceSessionId ||
      prepared.sessionIncarnation !== readiness.sessionIncarnation ||
      prepared.routeGeneration !== generation
    )
      throw new Error('Pi Voice target preparation lost its session incarnation.');
    return {
      scope,
      activationId,
      sessionIncarnation: readiness.sessionIncarnation,
      generation,
      transactionId,
      cursor: 0,
    };
  }

  private async admit(requestId: string, transcript: string): Promise<RealtimeDeliveryOutcome> {
    const transfer = this.transfer;
    if (transfer) {
      const bytes = Buffer.byteLength(transcript, 'utf8');
      if (transfer.held.length >= MAX_HELD || transfer.heldBytes + bytes > MAX_HELD_BYTES) return 'rejected';
      transfer.held.push({
        requestId,
        transcript,
        transactionId: transfer.transactionId,
        destination: transfer.targetSessionId,
      });
      transfer.heldBytes += bytes;
      return 'buffered';
    }
    const route = this.route;
    if (!route) return 'rejected';
    if (this.selectedRoute !== route) {
      try {
        await (this.activationSelection?.route === route ? this.activationSelection.promise : this.selecting);
      } catch {
        return 'rejected';
      }
    }
    return this.selectedRoute === route && this.route === route
      ? this.admitToRoute(route, requestId, transcript)
      : 'rejected';
  }

  private async admitToRoute(
    route: LiveAgentRoute,
    requestId: string,
    transcript: string,
  ): Promise<RealtimeDeliveryOutcome> {
    const receipts = this.options.receipts;
    if (!receipts || this.stopped || (this.route !== route && this.transfer?.target !== route)) return 'rejected';
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([requestId, transcript]))
      .digest('hex');
    const reservation = await receipts.reserve({
      namespace: ADMISSION_NAMESPACE,
      activationId: route.activationId,
      requestId,
      fingerprint,
      destination: `${route.scope.sessionId}:${route.sessionIncarnation}`,
      transactionId: route.transactionId,
    });
    if (reservation.kind === 'conflict') return 'rejected';
    if (reservation.kind === 'existing')
      return reservation.receipt.outcome === 'admitted'
        ? 'submitted'
        : reservation.receipt.outcome === 'rejected'
          ? 'rejected'
          : 'uncertain';
    const receipt = {
      namespace: ADMISSION_NAMESPACE,
      activationId: route.activationId,
      requestId,
      token: reservation.token,
    };
    if (this.stopped || (this.route !== route && this.transfer?.target !== route)) {
      await receipts.finish({ ...receipt, outcome: 'rejected' });
      return 'rejected';
    }
    try {
      const result = object(
        await this.agentRequest(route, AGENT_ADMIT, 'POST', {
          activationId: route.activationId,
          routeGeneration: route.generation,
          sessionIncarnation: route.sessionIncarnation,
          requestId,
          transcript,
          intent: 'immediate',
        }),
      );
      if (result?.admitted !== true || result.requestId !== requestId)
        throw new Error('Pi agent admission is uncertain.');
      await receipts.finish({ ...receipt, outcome: 'admitted' });
      if (this.route === route && !this.stopped) this.admitted.set(requestId, route);
      return this.stopped ? 'uncertain' : 'submitted';
    } catch (error) {
      await receipts.finish({ ...receipt, outcome: 'uncertain' }).catch((receiptError: unknown) => {
        this.options.onNotice(`Voice receipt finish failed: ${errorMessage(receiptError)}`);
        return undefined;
      });
      this.options.onNotice(`Voice admission is uncertain: ${errorMessage(error)}`);
      return 'uncertain';
    }
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined) return;
    this.pollTimer = setInterval(() => {
      const route = this.route;
      if (!route || this.polling) return;
      this.polling = true;
      void this.pollAgentResults(route)
        .catch((error: unknown) => this.options.onNotice(`Voice agent result poll failed: ${errorMessage(error)}`))
        .finally(() => {
          this.polling = false;
        });
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async pollAgentResults(route: LiveAgentRoute): Promise<boolean> {
    const path = `${AGENT_RESULTS}?${new URLSearchParams({
      activationId: route.activationId,
      routeGeneration: String(route.generation),
      sessionIncarnation: route.sessionIncarnation,
      after: String(route.cursor),
    }).toString()}`;
    const snapshot = object(await this.agentRequest(route, path, 'GET'));
    if (
      !snapshot ||
      !Array.isArray(snapshot.activeRuns) ||
      !Array.isArray(snapshot.events) ||
      !Number.isSafeInteger(snapshot.cursor)
    )
      throw new Error('Voice agent results are invalid.');
    const result = snapshot as unknown as LiveAgentResults;
    for (const event of result.events) {
      if (this.stopped || (this.route !== route && this.transfer?.source !== route)) return true;
      if (
        event.sourceSessionId !==
          (parseRemoteSessionReference(route.scope.sessionId)?.sessionId ?? route.scope.sessionId) ||
        event.sessionIncarnation !== route.sessionIncarnation ||
        !event.runId ||
        !event.resultId ||
        !Array.isArray(event.requestIds) ||
        !Number.isSafeInteger(event.sequence)
      )
        throw new Error('Voice agent result identity is invalid.');
      await this.publishResult(route, event);
      for (const requestId of event.requestIds)
        if (this.admitted.get(requestId) === route) this.admitted.delete(requestId);
    }
    if (result.cursor > route.cursor) {
      await this.agentRequest(route, AGENT_ACK, 'POST', {
        activationId: route.activationId,
        routeGeneration: route.generation,
        sessionIncarnation: route.sessionIncarnation,
        cursor: result.cursor,
      });
      route.cursor = result.cursor;
    }
    return result.activeRuns.length !== 0;
  }

  private async publishResult(route: LiveAgentRoute, event: LiveAgentResult): Promise<void> {
    const receipts = this.options.receipts;
    if (!receipts) throw new Error('Live Voice receipt storage is unavailable.');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          event.sourceSessionId,
          event.sessionIncarnation,
          event.runId,
          event.resultId,
          event.assistantText,
          event.status,
        ]),
      )
      .digest('hex');
    const reservation = await receipts.reserve({
      namespace: PUBLICATION_NAMESPACE,
      activationId: route.activationId,
      requestId: event.resultId,
      fingerprint,
      destination: `${route.scope.sessionId}:${route.sessionIncarnation}`,
      transactionId: route.transactionId,
    });
    if (reservation.kind === 'conflict')
      throw new Error('Voice result identity conflicts with a previous publication.');
    if (reservation.kind === 'existing') {
      if (reservation.receipt.outcome !== 'admitted') throw new Error('Voice result publication is uncertain.');
      return;
    }
    const text = event.status === 'completed' ? event.assistantText : undefined;
    const published = await this.live.publishAgentResult(event.resultId, text, event.requestIds);
    await receipts.finish({
      namespace: PUBLICATION_NAMESPACE,
      activationId: route.activationId,
      requestId: event.resultId,
      token: reservation.token,
      outcome: published ? 'admitted' : 'uncertain',
    });
    if (!published) throw new Error('Voice result publication is uncertain.');
  }

  private async agentRequest(
    route: Pick<LiveAgentRoute, 'scope'>,
    path: string,
    method: 'GET' | 'POST',
    body?: object,
  ): Promise<unknown> {
    const hub = this.hub;
    if (!hub) throw new Error('Global Voice agent host has been disposed.');
    const remote = parseRemoteSessionReference(route.scope.sessionId);
    const response =
      remote && this.options.homeDirectory
        ? await requestPairedVoiceAgent(
            this.options.homeDirectory,
            route.scope.sessionId,
            path,
            method,
            body ? JSON.stringify(body) : undefined,
          )
        : await hub.requestSessionApi(route.scope, {
            basePath: AGENT_BASE_PATH,
            path,
            method,
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
    if (!response.ok) throw new Error(`Pi Voice agent request failed with HTTP ${String(response.status)}.`);
    if (response.status === 204) return undefined;
    return response.json() as Promise<unknown>;
  }

  /** The page reaches only this owner-authenticated public control surface. */
  public readonly api: DoomApi = {
    basePath: 'voice',
    start: () => ({
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === '/live/status') return Response.json(this.status);
        if (request.method !== 'POST' || path !== '/live/control')
          return Response.json({ error: 'Not found.' }, { status: 404 });
        const body = object(await request.json().catch(() => undefined));
        if (
          !body ||
          !['activate', 'transfer', 'end', 'mute', 'unmute', 'interrupt'].includes(String(body.action)) ||
          ((body.action === 'activate' || body.action === 'transfer') && typeof body.sessionId !== 'string') ||
          (body.expectedSourceSessionId !== undefined &&
            (typeof body.expectedSourceSessionId !== 'string' || body.expectedSourceSessionId.length > 256))
        )
          return Response.json({ error: 'Invalid global Voice control.' }, { status: 400 });
        try {
          return Response.json(await this.control(body as unknown as GlobalLiveControl));
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 409 });
        }
      },
      close: () => undefined,
    }),
  };
}
