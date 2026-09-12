import { Context, Service } from '@deepseek-ai/cordis';
import { createDoomKernel } from '@agimon-ai/doompi-kernel';
import { formatSkillsForSystemPrompt } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  readDoomHeadlessOwner,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessEventName,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHook,
  type DoomHeadlessHostService,
  type DoomHeadlessRegistration,
  type DoomHeadlessResource,
  type DoomHeadlessSelection,
  type DoomHeadlessSelectionChange,
  type DoomHeadlessTool,
  type DoomHeadlessCondition,
  type DoomHeadlessToolRestriction,
  type DoomHeadlessMinorMode,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { DoomServerBundleEntry } from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { PackageAttribution } from '@agimon-ai/doompi-config/types';
import type { CountTokens } from '@agimon-ai/doompi-ui/toolInventory';
import type {
  HeadlessContextInventory,
  HeadlessHostOptions,
  HeadlessSelectionStatus,
  ResolvedHeadlessResource,
} from '../types/server/headlessHost';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeCatalogService,
  type MinorModeOwnerHandle,
} from '@agimon-ai/doompi-extension-contracts/mode';
import { createMinorModeCatalogHost } from '../services/modeCatalog';
import type {
  ContextConditionalAttribution,
  ContextToolInventory,
  ContextToolSource,
} from '../services/contextProjection';

type Owned<T> = { source: string; value: T };
type StopActivity = () => void | Promise<void>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSelection(left: DoomHeadlessSelection, right: DoomHeadlessSelection): boolean {
  return (
    left.majorMode === right.majorMode &&
    left.profile === right.profile &&
    sameStrings(left.activeLayers, right.activeLayers) &&
    sameStrings(left.domains, right.domains) &&
    sameStrings(left.minorModes, right.minorModes)
  );
}

/** Maps one typed headless resource to the exact skill shape installed in AgentHarness. */
export function headlessHarnessSkill(resource: ResolvedHeadlessResource) {
  return {
    name: resource.name,
    description: `Headless skill from ${resource.source}`,
    content: resource.text,
    filePath: `doom-headless://${resource.source}/${resource.name}`,
  };
}

/** Retains facets and their state; only kernel-computed active contributions change. */
export class HeadlessHost extends Service<DoomHeadlessHostService> implements DoomHeadlessHostService {
  private readonly kernel = createDoomKernel();
  readonly catalog: MinorModeCatalogService;
  private restrictions: readonly DoomHeadlessToolRestriction[] = [];
  private readonly options: HeadlessHostOptions;
  private readonly selectionOverrides: Set<string>;
  private applied: DoomHeadlessSelection;
  private requested: DoomHeadlessSelection;
  private applying: DoomHeadlessSelection;
  private refreshing = false;
  private requestedRevision = 0;
  private appliedRevision = 0;
  private ready = false;
  private disposed = false;
  private failure: unknown;
  private tail: Promise<void> = Promise.resolve();
  private activeSources = new Set<string>();
  private availableSources = new Set<string>();
  private tools = new Map<string, Owned<DoomHeadlessTool>>();
  private resources: readonly Owned<DoomHeadlessResource>[] = [];
  private resolvedResources: readonly ResolvedHeadlessResource[] = [];
  private commands = new Map<string, Owned<DoomHeadlessCommand>>();
  private hooks: readonly Owned<DoomHeadlessHook>[] = [];
  private readonly activities = new Map<Owned<DoomHeadlessActivity>, StopActivity>();

  constructor(context: Context, options: HeadlessHostOptions) {
    super(context, DOOM_HEADLESS_HOST_SERVICE);
    this.options = options;
    this.selectionOverrides = new Set(options.selectionOverrides);
    this.applied = structuredClone(options.selection);
    this.requested = this.applied;
    this.applying = this.applied;
    this.catalog = createMinorModeCatalogHost({
      sessionKind: 'headless',
      context: { sessionManager: { getSessionId: () => this.context.sessionId } },
      routeInvocation: async (_request, _source, invoke) => {
        this.assertReady();
        const response = await invoke();
        await this.options.onMinorModeChanged?.();
        return response;
      },
    });
    context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, this.catalog);
    context.effect(() => () => this.close(), 'headless host lifetime');
    this.kernel.defineSlot<Owned<DoomHeadlessToolRestriction>>('restrictions', (entries) => {
      this.restrictions = entries
        .map((entry) => entry.value)
        .filter((restriction) => this.applying.minorModes.includes(restriction.minorMode));
    });
    this.kernel.defineSlot<Owned<DoomHeadlessTool>>('tools', async (entries) => {
      const allowed = this.options.allowedTools?.(this.applying);
      const next = new Map<string, Owned<DoomHeadlessTool>>();
      for (const entry of this.selected(entries)) {
        if (allowed !== undefined && !allowed.includes(entry.value.name)) continue;
        if (this.restrictions.some((restriction) => !restriction.allowedTools.includes(entry.value.name))) continue;
        if (!next.has(entry.value.name)) next.set(entry.value.name, entry);
      }
      const tools = [...next.values()].map((entry): DoomHeadlessTool => ({
        ...entry.value,
        execute: async (id, parameters, signal, onUpdate) => {
          this.assertReady();
          if (this.tools.get(entry.value.name) !== entry || !this.activeSources.has(entry.source)) {
            throw new Error(`Tool '${entry.value.name}' is no longer active`);
          }
          return entry.value.execute(id, parameters, signal, onUpdate, this.context);
        },
      }));
      await this.options.applyTools(tools);
      this.tools = next;
    });
    this.kernel.defineSlot<Owned<DoomHeadlessResource>>('resources', async (entries) => {
      this.resources = this.selected(entries);
      this.resolvedResources = await this.resolveResources(this.applying);
      await this.options.applyResources(this.resolvedResources);
    });
    this.kernel.defineSlot<Owned<DoomHeadlessCommand>>('commands', (entries) => {
      const next = new Map<string, Owned<DoomHeadlessCommand>>();
      for (const entry of this.selected(entries)) if (!next.has(entry.value.name)) next.set(entry.value.name, entry);
      this.commands = next;
    });
    this.kernel.defineSlot<Owned<DoomHeadlessHook>>('hooks', (entries) => {
      this.hooks = this.selected(entries);
    });
    this.kernel.defineSlot<Owned<DoomHeadlessActivity>>('activities', async (entries) => {
      const desired = new Set(this.selected(entries));
      for (const [entry, stop] of [...this.activities].reverse()) {
        if (desired.has(entry)) continue;
        await stop();
        this.activities.delete(entry);
      }
      for (const entry of desired) {
        if (this.activities.has(entry)) continue;
        try {
          const stop = await entry.value.start(this.options.context(this.applying));
          this.activities.set(entry, stop);
        } catch (error) {
          if (this.options.candidates.some((candidate) => candidate.packageName === entry.source && candidate.required))
            throw error;
          this.options.onError?.(error);
        }
      }
    });
  }

  get context(): DoomHeadlessExecutionContext {
    return this.options.context(this.applied);
  }

  get status(): HeadlessSelectionStatus {
    return {
      requestedRevision: this.requestedRevision,
      appliedRevision: this.appliedRevision,
      ready: this.ready,
      ...(this.failure === undefined
        ? {}
        : {
            error:
              this.failure instanceof Error
                ? this.failure.message
                : typeof this.failure === 'string'
                  ? this.failure
                  : 'Headless selection failed',
          }),
    };
  }

  getContextInventory(
    selection: DoomHeadlessSelection = this.applied,
    countTokens?: CountTokens,
  ): HeadlessContextInventory {
    const currentSources = new Set(
      this.options.candidates
        .filter(
          (candidate) =>
            candidate.scopes.includes('session') &&
            candidate.owners.some((owner) => owner.majorMode === selection.majorMode),
        )
        .map((candidate) => candidate.packageName),
    );
    const modeLabels = new Map(
      this.catalog.getSnapshot().modes.map(({ descriptor }) => [descriptor.id, descriptor.label]),
    );
    const conditionAttribution = (when?: DoomHeadlessCondition): ContextConditionalAttribution | undefined => {
      if (when?.minorMode !== undefined) {
        const label = modeLabels.get(when.minorMode);
        return {
          kind: 'minor',
          mode: when.minorMode,
          ...(label === undefined ? {} : { label }),
        };
      }
      return when?.domain === undefined ? undefined : { kind: 'domain', mode: when.domain };
    };
    const toolsBySource = new Map<string, ContextToolInventory[]>();
    for (const contribution of this.kernel.contributions<Owned<DoomHeadlessTool>>('tools')) {
      if (!currentSources.has(contribution.source)) continue;
      const tool = contribution.value.value;
      const contextAttribution = conditionAttribution(tool.when);
      const entry: ContextToolInventory = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
        ...(tool.promptGuidelines === undefined ? {} : { promptGuidelines: tool.promptGuidelines }),
        active: this.tools.get(tool.name) === contribution.value,
        ...(contextAttribution === undefined ? {} : { contextAttribution }),
      };
      const tools = toolsBySource.get(contribution.source);
      if (tools) tools.push(entry);
      else toolsBySource.set(contribution.source, [entry]);
    }

    const sources: ContextToolSource[] = [...toolsBySource].map(([source, tools]) => ({
      key: source,
      label: `${source} · extension`,
      kind: 'extension',
      packageName: source,
      tools,
    }));
    const framingTokens = countTokens === undefined ? 0 : countTokens(formatSkillsForSystemPrompt([]));
    const skills = this.resolvedResources.flatMap((resource, index) => {
      if (resource.kind !== 'skill') return [];
      const skill = headlessHarnessSkill(resource);
      const contextAttribution = conditionAttribution(this.resources[index]?.value.when);
      return [
        {
          name: skill.name,
          description: skill.description,
          group: 'extensions' as const,
          owner: resource.source,
          modelInvocable: true,
          ...(countTokens === undefined
            ? {}
            : { promptTokens: Math.max(0, countTokens(formatSkillsForSystemPrompt([skill])) - framingTokens) }),
          ...(contextAttribution === undefined ? {} : { contextAttribution }),
        },
      ];
    });
    const attribution: Record<string, PackageAttribution> = {};
    for (const candidate of this.options.candidates) {
      const owner =
        candidate.owners.find(
          (entry) =>
            entry.majorMode === selection.majorMode &&
            (entry.layer === 'default' || selection.activeLayers.includes(entry.layer)),
        ) ?? candidate.owners.find((entry) => entry.majorMode === selection.majorMode);
      if (owner && attribution[candidate.packageName] === undefined) {
        attribution[candidate.packageName] = { kind: 'major', mode: selection.majorMode, layer: owner.layer };
      }
    }
    return { sources, skills, attribution };
  }

  setAvailableSources(sources: readonly string[]): void {
    this.availableSources = new Set(sources);
  }
  private selected<T extends { when?: DoomHeadlessCondition }>(entries: readonly Owned<T>[]): readonly Owned<T>[] {
    return entries.filter(
      ({ value }) =>
        (value.when?.minorMode === undefined || this.applying.minorModes.includes(value.when.minorMode)) &&
        (value.when?.domain === undefined || this.applying.domains.includes(value.when.domain)),
    );
  }

  registerMinorMode(mode: DoomHeadlessMinorMode): MinorModeOwnerHandle {
    const owner = readDoomHeadlessOwner(this.ctx);
    if (!owner) throw new Error('A minor mode must have descriptor-owned package identity');
    const handle = this.catalog.registerOwner({
      ...mode,
      handleAction: (id, args, execution) => {
        this.assertReady();
        if (!this.activeSources.has(owner.packageName))
          throw new Error(`Minor-mode owner '${owner.packageName}' is inactive`);
        return mode.handleAction(id, args, { ...execution, context: this.context });
      },
    });
    this.ctx.effect(() => () => handle.dispose(), 'headless minor-mode owner');
    return handle;
  }

  registerToolRestriction(restriction: DoomHeadlessToolRestriction): DoomHeadlessRegistration {
    return this.add('restrictions', restriction);
  }

  private eligible(entry: DoomServerBundleEntry, selection: DoomHeadlessSelection): boolean {
    return (
      entry.scopes.includes('session') &&
      entry.owners.some(
        (owner) =>
          owner.majorMode === selection.majorMode &&
          (owner.layer === 'default' || selection.activeLayers.includes(owner.layer)),
      )
    );
  }

  changeSelection(change: DoomHeadlessSelectionChange): Promise<void> {
    this.selectionOverrides.add(change.axis);
    if (change.axis === 'majorMode') return this.select({ majorMode: change.majorMode });
    if (change.axis === 'domains') return this.select({ domains: change.domains });
    if (change.axis === 'profile') return this.select({ profile: change.profile });
    return this.select({ minorModes: change.minorModes });
  }

  private async refreshChangedSelection(
    previous: DoomHeadlessSelection,
    selection: DoomHeadlessSelection,
    previousValues: ReadonlyMap<string, readonly unknown[]>,
  ): Promise<void> {
    const majorChanged =
      previous.majorMode !== selection.majorMode || !sameStrings(previous.activeLayers, selection.activeLayers);
    const domainsChanged = !sameStrings(previous.domains, selection.domains);
    const profileChanged = previous.profile !== selection.profile;
    const minorModesChanged = !sameStrings(previous.minorModes, selection.minorModes);
    if (this.appliedRevision === 0) return;

    const refresh = async (slot: string): Promise<void> => {
      const before = previousValues.get(slot) ?? [];
      if (sameValues(before, this.kernel.activeValues(slot))) await this.kernel.refresh(slot);
    };
    if (minorModesChanged) await refresh('restrictions');
    if (majorChanged || domainsChanged || minorModesChanged) await refresh('tools');
    if (majorChanged || domainsChanged || profileChanged || minorModesChanged) await refresh('resources');
    if (domainsChanged || minorModesChanged) {
      await refresh('commands');
      await refresh('hooks');
      await refresh('activities');
    }
  }

  /** Refresh inherited defaults only at turn admission, keeping explicit session axes. */
  async inheritSelection(selection: Partial<DoomHeadlessSelection>): Promise<void> {
    const patch: Partial<DoomHeadlessSelection> = {
      ...(!this.selectionOverrides.has('majorMode') && selection.majorMode !== undefined
        ? { majorMode: selection.majorMode }
        : {}),
      ...(!this.selectionOverrides.has('domains') && selection.domains !== undefined
        ? { domains: selection.domains }
        : {}),
      ...(!this.selectionOverrides.has('profile') && Object.hasOwn(selection, 'profile')
        ? { profile: selection.profile }
        : {}),
    };
    await this.select(patch);
  }

  async select(patch: Partial<DoomHeadlessSelection>): Promise<void> {
    if (this.disposed) throw new Error('The headless host is disposed');
    const requested = structuredClone({ ...this.requested, ...patch });
    this.requested = requested;
    const revision = ++this.requestedRevision;
    this.ready = false;
    const apply = async (): Promise<void> => {
      if (this.disposed) throw new Error('The headless host is disposed');
      const selection = structuredClone((await this.options.resolveSelection?.(requested)) ?? requested);
      await this.options.validateSelection?.(selection);
      if (revision === this.requestedRevision) this.requested = selection;
      const eligible = this.options.candidates.filter((entry) => this.eligible(entry, selection));
      const missing = eligible.find((entry) => entry.required && !this.availableSources.has(entry.packageName));
      if (missing) throw new Error(`Required headless package '${missing.packageName}' is unavailable`);
      // The kernel's layer key here is the precomputed package eligibility key.
      // Minor tool restrictions run in the tools sink only after this owner gate.
      this.applying = selection;
      this.refreshing = true;
      try {
        const previousValues = new Map(
          this.kernel.slots.map((slot) => [slot, this.kernel.activeValues(slot)] as const),
        );
        await this.kernel.setActiveLayers(eligible.map((entry) => entry.packageName));
        await this.refreshChangedSelection(this.applied, selection, previousValues);
        const compositionChanged =
          this.appliedRevision === 0 ||
          !sameSelection(this.applied, selection) ||
          !sameValues(previousValues.get('tools') ?? [], this.kernel.activeValues('tools')) ||
          !sameValues(previousValues.get('resources') ?? [], this.kernel.activeValues('resources'));
        if (compositionChanged) await this.options.onApplied?.(selection, revision);
      } finally {
        this.refreshing = false;
      }
      if (this.disposed) throw new Error('The headless host is disposed');
      this.activeSources = new Set(eligible.map((entry) => entry.packageName));
      this.applied = selection;
      this.appliedRevision = revision;
      this.failure = undefined;
      this.ready = revision === this.requestedRevision;
    };
    const result = this.tail.catch(() => undefined).then(apply);
    this.tail = result.catch((error: unknown) => {
      this.failure = error;
      this.ready = false;
      this.options.onError?.(error);
    });
    return result;
  }

  private assertReady(): void {
    if (this.disposed || !this.ready)
      throw new Error('Headless dispatch is blocked until selection is coherently applied');
  }

  private add<T>(slot: string, value: T): DoomHeadlessRegistration {
    const owner = readDoomHeadlessOwner(this.ctx);
    if (!owner) throw new Error('A headless contribution must have descriptor-owned package identity');
    this.ready = false;
    const registration = this.kernel.contribute(slot, {
      source: owner.packageName,
      layer: owner.packageName,
      value: { source: owner.packageName, value } satisfies Owned<T>,
    });
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      this.ready = false;
      registration.dispose();
      if (!this.disposed && !this.refreshing) void this.select({}).catch(() => undefined);
    };
    this.ctx.effect(() => dispose, `headless ${slot} contribution`);
    // Initial registration is reconciled once the caller has installed all facets.
    if (this.appliedRevision > 0 && !this.refreshing) void this.select({}).catch(() => undefined);
    return { dispose };
  }

  registerTool<TParameters extends TSchema>(tool: DoomHeadlessTool<TParameters>): DoomHeadlessRegistration {
    return this.add('tools', tool);
  }
  registerResource(resource: DoomHeadlessResource): DoomHeadlessRegistration {
    return this.add('resources', resource);
  }
  registerCommand(command: DoomHeadlessCommand): DoomHeadlessRegistration {
    return this.add('commands', command);
  }
  registerHook(hook: DoomHeadlessHook): DoomHeadlessRegistration {
    return this.add('hooks', hook);
  }
  registerActivity(activity: DoomHeadlessActivity): DoomHeadlessRegistration {
    return this.add('activities', activity);
  }

  listCommands(): Array<Pick<DoomHeadlessCommand, 'name' | 'description'>> {
    this.assertReady();
    return [...this.commands.values()].map(({ value }) => ({ name: value.name, description: value.description }));
  }

  async dispatchCommand(name: string, args: string): Promise<void> {
    this.assertReady();
    const command = this.commands.get(name);
    if (!command) throw new Error(`Command '${name}' is inactive or unknown`);
    await command.value.execute(args, this.context);
  }

  async dispatchHook(event: DoomHeadlessEventName, payload: Readonly<Record<string, unknown>>): Promise<unknown[]> {
    this.assertReady();
    const results: unknown[] = [];
    const revision = this.appliedRevision;
    let current = payload;
    for (const hook of this.hooks.filter((entry) => entry.value.event === event)) {
      this.assertReady();
      if (!this.hooks.includes(hook)) continue;
      let result: unknown;
      try {
        result = await hook.value.handle(current as never, this.context);
      } catch (error) {
        this.options.onError?.(error);
        continue;
      }
      if (event === 'session_start') {
        // Startup hooks may register retained contributions. Finish their queued reconciliation
        // before the next hook, without relaxing dispatch guards during the transition.
        await this.tail;
        this.assertReady();
      }
      results.push(result);
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const patch = result as Record<string, unknown>;
        // Execution hooks compose in registration order, just like the public harness hooks.
        const fields =
          event === 'context'
            ? ['messages', 'systemPrompt']
            : event === 'tool_call'
              ? ['args']
              : event === 'tool_result'
                ? ['content', 'details', 'isError', 'usage']
                : event === 'before_agent_start'
                  ? ['systemPrompt']
                  : event === 'before_provider_request'
                    ? ['payload']
                    : [];
        for (const field of fields) {
          if (event === 'before_agent_start' && typeof patch[field] !== 'string') continue;
          if (patch[field] !== undefined) current = { ...current, [field]: patch[field] };
        }
        // Denials and structural decisions use upstream first-result semantics.
        if (event === 'tool_call' && patch.block !== undefined) break;
        if (
          event === 'session_before_compact' &&
          (patch.cancel !== undefined || patch.decline !== undefined || patch.compaction !== undefined)
        )
          break;
      }
    }
    if (event === 'before_agent_start' || event === 'context' || event === 'tool_call') {
      this.assertReady();
      if (revision !== this.appliedRevision) {
        throw new Error(
          event === 'before_agent_start'
            ? 'Selection changed while preparing the system prompt'
            : `Selection changed while dispatching ${event}`,
        );
      }
    }
    return results;
  }

  private async resolveResources(selection: DoomHeadlessSelection): Promise<readonly ResolvedHeadlessResource[]> {
    const context = this.options.context(selection);
    const result: ResolvedHeadlessResource[] = [];
    for (const resource of this.resources) {
      let value: string;
      try {
        value = await resource.value.read(context);
      } catch (error) {
        throw new Error(`Could not read headless resource '${resource.source}/${resource.value.name}'`, {
          cause: error,
        });
      }
      result.push({
        source: resource.source,
        name: resource.value.name,
        kind: resource.value.kind,
        text: value,
      });
    }
    return result;
  }

  async readResources(): Promise<readonly ResolvedHeadlessResource[]> {
    this.assertReady();
    const revision = this.appliedRevision;
    const result = await this.resolveResources(this.applied);
    this.assertReady();
    if (revision !== this.appliedRevision) throw new Error('Selection changed while reading resources');
    return result;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.catalog.dispose();
    await this.tail.catch(() => undefined);
    const failures: unknown[] = [];
    for (const stop of [...this.activities.values()].reverse()) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    this.activities.clear();
    this.kernel.dispose();
    if (failures.length) throw new AggregateError(failures, 'Headless activities failed to stop');
  }
}
