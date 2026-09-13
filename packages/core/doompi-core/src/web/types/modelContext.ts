/** The model-visible part of a WebMCP tool registration. */
export interface ModelContextToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelContextAbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface ModelContextExecutionOptions {
  readonly signal: ModelContextAbortSignal;
}

export interface ModelContextRegistrationOptions {
  readonly signal: ModelContextAbortSignal;
}

/** A descriptor plus the page callback that implements it. */
export interface ModelContextTool extends ModelContextToolDescriptor {
  execute(input: string, options: ModelContextExecutionOptions): Promise<unknown>;
}

export interface ModelContextToolChangeEvent {
  readonly type: 'toolchange';
}

export type ModelContextToolChangeListener = (event: ModelContextToolChangeEvent) => void;

/** The common surface supplied by either the browser or DoomPi's simulator. */
export interface ModelContext {
  registerTool(tool: ModelContextTool, options: ModelContextRegistrationOptions): void | Promise<void>;
  getTools(): Promise<readonly ModelContextToolDescriptor[]>;
  executeTool(name: string, input: string, options: ModelContextExecutionOptions): Promise<unknown>;
  addEventListener(type: 'toolchange', listener: ModelContextToolChangeListener): void;
  removeEventListener(type: 'toolchange', listener: ModelContextToolChangeListener): void;
}

export interface ModelContextBinding {
  readonly kind: 'native' | 'simulator';
  readonly modelContext: ModelContext;
}
