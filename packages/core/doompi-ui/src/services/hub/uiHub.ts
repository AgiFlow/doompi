import type {
  ConfigSection,
  DoomConfigActionInput,
  DoomConfigContributionHandle,
  DoomConfigContributionOptions,
  DoomConfigInvocation,
  DoomConfigSectionView,
  DoomExtensionContext,
} from '@agimon-ai/doompi-extension-contracts/config';
import type {
  DoomFooterContributionDefinition,
  DoomFooterContributionHandle,
  DoomFooterContributionValue,
  DoomFooterStatus,
} from '@agimon-ai/doompi-extension-contracts/footer';
import type { DoomLeaderActionHandlerOptions, LeaderBinding } from '@agimon-ai/doompi-extension-contracts/leader';
import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { DoomLeaderDiagnostic, DoomLeaderRegistry } from '../leader/leaderRegistry.ts';

type Listener = () => void;

function notify(listeners: ReadonlySet<Listener>): void {
  for (const listener of listeners) listener();
}

function copyBindings(bindings: readonly LeaderBinding[]): LeaderBinding[] {
  return bindings.map((binding) => ({
    ...binding,
    path: binding.path.map((segment) => ({ ...segment })) as [
      LeaderBinding['path'][number],
      ...LeaderBinding['path'][number][],
    ],
    ...('command' in binding ? { command: { ...binding.command } } : { action: { ...binding.action } }),
  }));
}

function copySections(sections: readonly ConfigSection[]): ConfigSection[] {
  return sections.map((section) => ({
    ...section,
    fields: section.fields.map((field) => ({
      ...field,
      ...(field.choices ? { choices: field.choices.map((choice) => ({ ...choice })) } : {}),
      ...(field.actions ? { actions: field.actions.map((action) => ({ ...action })) } : {}),
      ...(field.steps ? { steps: field.steps.map((step) => ({ ...step })) } : {}),
      ...(field.output ? { output: [...field.output] } : {}),
    })),
  }));
}

interface ActiveFooterContribution {
  readonly token: symbol;
  readonly definition: DoomFooterContributionDefinition;
  value?: DoomFooterContributionValue;
}

export class DoomUiFooterStore {
  private readonly contributions = new Map<string, ActiveFooterContribution>();
  private readonly listeners = new Set<Listener>();

  register(definition: DoomFooterContributionDefinition): DoomFooterContributionHandle {
    const token = Symbol(definition.source);
    const contribution: ActiveFooterContribution = { token, definition: { ...definition } };
    this.contributions.set(definition.source, contribution);
    notify(this.listeners);
    let disposed = false;
    return {
      update: (value) => {
        if (disposed || this.contributions.get(definition.source)?.token !== token) return;
        contribution.value = value
          ? {
              ...value,
              ...(value.fullSegments ? { fullSegments: value.fullSegments.map((segment) => ({ ...segment })) } : {}),
              ...(value.compactSegments
                ? { compactSegments: value.compactSegments.map((segment) => ({ ...segment })) }
                : {}),
            }
          : undefined;
        notify(this.listeners);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.contributions.get(definition.source)?.token !== token) return;
        this.contributions.delete(definition.source);
        notify(this.listeners);
      },
    };
  }

  getStatuses(): DoomFooterStatus[] {
    return [...this.contributions.values()]
      .flatMap(({ definition, value }) =>
        value
          ? [
              {
                source: definition.source,
                id: definition.id,
                order: definition.order,
                ...(definition.placement ? { placement: definition.placement } : {}),
                ...value,
              },
            ]
          : [],
      )
      .toSorted(
        (left, right) =>
          left.order - right.order || left.source.localeCompare(right.source) || left.id.localeCompare(right.id),
      );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.contributions.clear();
    notify(this.listeners);
    this.listeners.clear();
  }
}

interface ActiveConfigContribution {
  readonly token: symbol;
  readonly options: DoomConfigContributionOptions<DoomExtensionContext>;
}

export class DoomUiConfigStore {
  private readonly contributions = new Map<string, ActiveConfigContribution>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly getContext: () => DoomExtensionContext | undefined) {}

  register<ExtensionContext extends DoomExtensionContext>(
    options: DoomConfigContributionOptions<ExtensionContext>,
  ): DoomConfigContributionHandle {
    const token = Symbol(options.source);
    const contribution = {
      token,
      options: options as unknown as DoomConfigContributionOptions<DoomExtensionContext>,
    };
    this.contributions.set(options.source, contribution);
    notify(this.listeners);
    let disposed = false;
    return {
      update: () => {
        if (!disposed && this.contributions.get(options.source)?.token === token) notify(this.listeners);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.contributions.get(options.source)?.token !== token) return;
        this.contributions.delete(options.source);
        notify(this.listeners);
      },
    };
  }

  getSections(): DoomConfigSectionView[] {
    return [...this.contributions.values()]
      .flatMap(({ options }) => {
        try {
          return copySections(options.listSections()).map((section) => ({ source: options.source, ...section }));
        } catch (error) {
          const context = this.getContext();
          if (context) options.onError(error, 'listSections', context);
          return [];
        }
      })
      .toSorted(
        (left, right) =>
          left.order - right.order || left.source.localeCompare(right.source) || left.id.localeCompare(right.id),
      );
  }

  invoke(invocation: DoomConfigInvocation): void {
    const active = this.contributions.get(invocation.source);
    const context = this.getContext();
    if (!active || !context) return;
    const handler = active.options.handlers[invocation.action];
    if (!handler) return;
    const input: DoomConfigActionInput = {
      ctx: context,
      sectionId: invocation.sectionId,
      fieldId: invocation.fieldId,
      ...(invocation.value === undefined ? {} : { value: invocation.value }),
    };
    void Promise.resolve(handler(input))
      .catch((error: unknown) => active.options.onError(error, invocation.action, context))
      .finally(() => {
        if (this.contributions.get(invocation.source)?.token === active.token) notify(this.listeners);
      });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.contributions.clear();
    notify(this.listeners);
    this.listeners.clear();
  }
}

export interface DoomUiHubController extends DoomUiHubService {
  readonly config: DoomUiConfigStore;
  readonly footer: DoomUiFooterStore;
  setContext(context: DoomExtensionContext | undefined): void;
  invokeLeaderAction(source: string, action: string): void;
  dispose(): void;
}

export interface CreateDoomUiHubOptions {
  readonly leaderRegistry: DoomLeaderRegistry;
  readonly reportDiagnostics: (diagnostics: readonly DoomLeaderDiagnostic[]) => void;
}

export function createDoomUiHub({ leaderRegistry, reportDiagnostics }: CreateDoomUiHubOptions): DoomUiHubController {
  let activeContext: DoomExtensionContext | undefined;
  const leaderGenerations = new Map<string, symbol>();
  const actionHandlers = new Map<
    string,
    { token: symbol; options: DoomLeaderActionHandlerOptions<DoomExtensionContext> }
  >();
  const footer = new DoomUiFooterStore();
  const config = new DoomUiConfigStore(() => activeContext);

  return {
    footer,
    config,
    registerLeader(contribution) {
      const token = Symbol(contribution.source);
      const publish = (bindings: readonly LeaderBinding[]): void => {
        const result = leaderRegistry.register({ source: contribution.source, bindings: copyBindings(bindings) });
        reportDiagnostics(result.diagnostics);
      };
      publish(contribution.bindings);
      leaderGenerations.set(contribution.source, token);
      let disposed = false;
      return {
        update(bindings) {
          if (disposed || leaderGenerations.get(contribution.source) !== token) return;
          publish(bindings);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          if (leaderGenerations.get(contribution.source) !== token) return;
          leaderGenerations.delete(contribution.source);
          publish([]);
        },
      };
    },
    registerLeaderActions(options) {
      const token = Symbol(options.source);
      actionHandlers.set(options.source, {
        token,
        options: options as unknown as DoomLeaderActionHandlerOptions<DoomExtensionContext>,
      });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        if (actionHandlers.get(options.source)?.token === token) actionHandlers.delete(options.source);
      };
    },
    registerFooter: (definition) => footer.register(definition),
    registerConfig: (options) => config.register(options),
    setContext(context) {
      activeContext = context;
    },
    invokeLeaderAction(source, action) {
      const context = activeContext;
      const active = actionHandlers.get(source);
      if (!context || !active) return;
      const handler = active.options.handlers[action];
      if (!handler) return;
      void Promise.resolve(handler(context)).catch((error: unknown) => active.options.onError(error, action, context));
    },
    dispose() {
      activeContext = undefined;
      actionHandlers.clear();
      leaderGenerations.clear();
      footer.dispose();
      config.dispose();
    },
  };
}
