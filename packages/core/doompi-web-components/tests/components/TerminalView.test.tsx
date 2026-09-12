import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TerminalView } from '../../src/components/TerminalView';

describe('TerminalView', () => {
  it('renders an inert terminal mount before the browser emulator is ready', () => {
    const out = renderToStaticMarkup(<TerminalView className="session-terminal" aria-label="shell" />);

    expect(out).toContain('data-slot="terminal-view"');
    expect(out).toContain('data-ready="false"');
    expect(out).toContain('class="h-full w-full session-terminal"');
    expect(out).toContain('aria-label="shell"');
  });
});
