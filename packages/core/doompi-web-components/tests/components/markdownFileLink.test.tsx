import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '../../src/exports';

const imageHooks = vi.hoisted(() => ({
  enabled: false,
  state: undefined as unknown,
  effect: undefined as undefined | (() => (() => void) | undefined),
  element: undefined as unknown,
  src: 'pic.png',
}));
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    useState: (...args: Parameters<typeof react.useState>) =>
      imageHooks.enabled
        ? [
            imageHooks.state,
            (state: unknown) => {
              imageHooks.state = state;
            },
          ]
        : react.useState(...args),
    useEffect: (...args: Parameters<typeof react.useEffect>) => {
      if (imageHooks.enabled) imageHooks.effect = args[0] as typeof imageHooks.effect;
      else react.useEffect(...args);
    },
  };
});
vi.mock('react-markdown', async (original) => {
  const actual = await original<typeof import('react-markdown')>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      if (!imageHooks.enabled) return actual.default(props);
      const Image = props.components!.img as (props: { src: string; alt: string }) => import('react').ReactElement;
      imageHooks.element = Image({ src: imageHooks.src, alt: 'diagram' });
      return imageHooks.element;
    },
  };
});
afterEach(() => {
  imageHooks.enabled = false;
  imageHooks.state = undefined;
  imageHooks.effect = undefined;
});

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node);

describe('Markdown file links', () => {
  it('leaves inline code alone without a handler', () => {
    const out = html(<Markdown text="see `src/app.ts` for it" />);
    expect(out).toContain('<code');
    expect(out).not.toContain('markdown-file-link');
  });

  it('links only the inline code the handler claims', () => {
    const out = html(
      <Markdown
        text="`src/app.ts` uses `flex gap-3`"
        onFileLink={(text) => (text === 'src/app.ts' ? () => undefined : undefined)}
      />,
    );
    expect(out).toContain('data-testid="markdown-file-link"');
    expect(out).toContain('title="open src/app.ts"');
    // The class name the handler refused stays a plain code span.
    expect(out).toContain('flex gap-3</code>');
  });

  it('never turns a fenced block into a link', () => {
    const out = html(<Markdown text={['```', 'src/app.ts', '```'].join('\n')} onFileLink={() => () => undefined} />);
    expect(out).not.toContain('markdown-file-link');
  });
  it('opens a labelled file href through the explicit session resolver', () => {
    const calls: unknown[] = [];
    const out = html(
      <Markdown
        text="[the MP4](packages/review%20video.mp4)"
        onFileLink={(path, explicit) => {
          calls.push([path, explicit]);
          return () => undefined;
        }}
      />,
    );
    expect(calls).toEqual([['packages/review video.mp4', true]]);
    expect(out).toContain('data-testid="markdown-file-link"');
    expect(out).toContain('the MP4</button>');
    expect(out).not.toContain('target="_blank"');
  });

  it.each(['https://example.com/video.mp4', '//example.com/video.mp4', '#section', 'mailto:a@example.com'])(
    'keeps %s out of the file resolver',
    (href) => {
      const calls: string[] = [];
      const out = html(
        <Markdown
          text={`[link](${href})`}
          onFileLink={(path) => {
            calls.push(path);
            return () => undefined;
          }}
        />,
      );
      expect(calls).toEqual([]);
      expect(out).toContain('<a ');
    },
  );
});

describe('Markdown images', () => {
  it('shows an inline loading label instead of sending local paths to the browser', () => {
    const out = html(
      <Markdown
        text="![diagram](docs/pic%23one.png?raw#view)"
        loadImage={async () => ({ url: 'blob:image', dispose() {} })}
      />,
    );
    expect(out).toContain('diagram (loading...)');
    expect(out).not.toContain('<img');
  });
  it('leaves scheme URLs and images without a loader unchanged', () => {
    expect(
      html(
        <Markdown
          text="![remote](https://example.com/pic.png)"
          loadImage={async () => {
            throw new Error('not local');
          }}
        />,
      ),
    ).toContain('src="https://example.com/pic.png"');
    expect(html(<Markdown text="![local](pic.png)" />)).toContain('src="pic.png"');
  });
});

describe('Markdown image lifecycle', () => {
  const render = (loader: NonNullable<Parameters<typeof Markdown>[0]['loadImage']>) => {
    imageHooks.enabled = true;
    return html(<Markdown text="image" loadImage={loader} />);
  };
  it('decodes filenames after removing query and fragment, disposes loaded URLs and handles browser errors', async () => {
    imageHooks.src = 'docs/pic%23one%20two.png?raw#view';
    const dispose = vi.fn();
    const loader = vi.fn(async () => ({ url: 'blob:image', dispose }));
    expect(render(loader)).toContain('loading...');
    const cleanup = imageHooks.effect!();
    await vi.waitFor(() => expect(loader).toHaveBeenCalledWith('docs/pic#one two.png'));
    expect(render(loader)).toContain('src="blob:image"');
    const element = imageHooks.element as import('react').ReactElement<{ onError(): void }>;
    element.props.onError();
    expect(render(loader)).toContain('unavailable');
    cleanup!();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('disposes late arrivals without publishing them', async () => {
    imageHooks.src = '/cwd/pic.png';
    let resolve!: (asset: { url: string; dispose(): void }) => void;
    const loader = vi.fn(
      () =>
        new Promise<{ url: string; dispose(): void }>((done) => {
          resolve = done;
        }),
    );
    render(loader);
    const cleanup = imageHooks.effect!();
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    cleanup!();
    const dispose = vi.fn();
    resolve({ url: 'blob:late', dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(imageHooks.state).toBeUndefined();
  });
  it('never exposes a URL from another path or loader and displays fetch failures', async () => {
    imageHooks.src = 'pic.png';
    const loader = vi.fn(async () => ({ url: 'blob:old', dispose() {} }));
    render(loader);
    const cleanup = imageHooks.effect!();
    await vi.waitFor(() => expect(imageHooks.state).toMatchObject({ url: 'blob:old' }));
    const nextLoader = vi.fn(async () => {
      throw new Error('refused');
    });
    expect(render(nextLoader)).not.toContain('blob:old');
    imageHooks.src = 'other.png';
    expect(render(loader)).not.toContain('blob:old');
    cleanup!();
    render(nextLoader);
    const nextCleanup = imageHooks.effect!();
    await vi.waitFor(() => expect(imageHooks.state).toMatchObject({ failed: true }));
    expect(render(nextLoader)).toContain('unavailable');
    nextCleanup!();
  });
  it('rejects malformed encoding without fetching and ignores scheme URLs', async () => {
    const loader = vi.fn(async () => ({ url: 'blob:image', dispose() {} }));
    imageHooks.src = 'bad%ZZ.png';
    render(loader);
    const cleanup = imageHooks.effect!();
    await vi.waitFor(() => expect(imageHooks.state).toMatchObject({ failed: true }));
    expect(loader).not.toHaveBeenCalled();
    cleanup!();
    imageHooks.src = 'https://example.com/pic.png';
    expect(render(loader)).toContain('https://example.com/pic.png');
    expect(imageHooks.effect!()).toBeUndefined();
  });
});
