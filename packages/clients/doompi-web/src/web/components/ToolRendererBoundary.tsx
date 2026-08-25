import { Component, type ReactNode } from 'react';

interface ToolRendererBoundaryProps {
  toolName: string;
  /** Renders the item; `failed` is true once the plugin renderer threw, so the host item stands in. */
  children: (failed: boolean) => ReactNode;
}

interface ToolRendererBoundaryState {
  failed: boolean;
}

/**
 * Keeps one plugin's tool renderer from taking the timeline down with it: a
 * throw during render is logged once and the call falls back to the host's
 * own item, while every other entry keeps rendering.
 */
export class ToolRendererBoundary extends Component<ToolRendererBoundaryProps, ToolRendererBoundaryState> {
  override state: ToolRendererBoundaryState = { failed: false };

  static getDerivedStateFromError(): ToolRendererBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`web plugin tool renderer for '${this.props.toolName}' threw; showing the host item instead`, error);
  }

  override render(): ReactNode {
    return this.props.children(this.state.failed);
  }
}
