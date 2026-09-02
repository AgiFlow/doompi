import { EmptyState } from '@agimon-ai/doompi-web-components';
import type { SettingsPanelProps } from '@agimon-ai/doompi-web-contracts';

/**
 * The metrics settings page.
 *
 * Placeholder body: the route, the menu entry and the host transport are in
 * place, and the report this draws arrives with the hub API. Kept as its own
 * component from the start so the page that replaces this body does not also
 * have to change how it is mounted.
 */
export function MetricsPanel(_props: SettingsPanelProps) {
  return (
    <EmptyState
      title="no metrics yet"
      description="This page will chart tool failures, tokens by dimension, and cost over time from the local log sink."
      data-testid="metrics-placeholder"
    />
  );
}
