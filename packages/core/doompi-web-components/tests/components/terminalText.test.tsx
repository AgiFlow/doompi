import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnsiLine, AnsiText } from '../../src/components/AnsiText.tsx';

describe('terminal text', () => {
  it('renders terminal attributes as theme classes, then resets them', () => {
    const out = renderToStaticMarkup(
      <AnsiLine line={'\u001b[1;2;3;4;7;31mstyled\u001b[0m plain'} className="log-row" aria-label="output" />,
    );
    for (const name of ['font-bold', 'opacity-60', 'italic', 'underline', 'bg-doom-text', 'text-doom-deep']) {
      expect(out).toContain(name);
    }
    expect(out).toContain('class="log-row"');
    expect(out).toContain('aria-label="output"');
    expect(out).toContain('<span class=""> plain</span>');
    expect(out).not.toContain('\u001b');
  });

  it('uses inline colour only for RGB and indexed terminal colours', () => {
    const out = renderToStaticMarkup(
      <AnsiLine line={'\u001b[31mnamed\u001b[38;2;12;34;56mrgb\u001b[38;5;196mindexed'} />,
    );
    expect(out).toContain('text-doom-red');
    expect(out).toContain('style="color:rgb(12 34 56)"');
    expect(out).toContain('style="color:rgb(255 0 0)"');
  });

  it('preserves blank lines and resets attributes at each screen row', () => {
    const out = renderToStaticMarkup(<AnsiText text={'\u001b[31mred\nplain\n\n<end>\n'} className="log" />);
    expect(out).toContain('<pre data-slot="ansi-text" class="log">');
    expect(out).toContain('<span class="text-doom-red">red</span>\n<span class="">plain</span>\n\n');
    expect(out).toContain('&lt;end&gt;</span>\n</pre>');
    expect(renderToStaticMarkup(<AnsiText text="" />)).toBe('<pre data-slot="ansi-text"></pre>');
  });
});
