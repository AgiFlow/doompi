import { type ComponentProps, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { cn } from '../lib/cn';
import { themeVariable } from '../types/theme';

/**
 * A terminal emulator, for output that is a screen rather than a document.
 *
 * `AnsiText` beside it renders colour in text that happens to carry escapes.
 * This is the other thing: a full VT emulator that keeps a cursor, a grid and
 * an alternate screen, so a prompt, a progress bar or a full-screen program
 * behaves the way it would in a shell. Give it the bytes a pty produced and it
 * draws them; take its `onData` and you have what the reader typed.
 *
 * The emulator is loaded on mount rather than with the bundle. It is not a
 * small dependency, and most surfaces never show a terminal.
 */

export interface TerminalHandle {
  /** Writes pane bytes, escapes and all. */
  write(data: Uint8Array | string): void;
  /** Clears the screen and scrollback, for a stream that restarted. */
  reset(): void;
}

export interface TerminalViewProps extends Omit<ComponentProps<'div'>, 'children' | 'onData' | 'ref'> {
  /** What the reader typed, already encoded the way a terminal sends it. */
  onData?: (text: string) => void;
  /** Called once the emulator is live, so a caller can start feeding it. */
  onReady?: () => void;
  ref?: React.Ref<TerminalHandle>;
  fontSize?: number;
}

const DEFAULT_FONT_SIZE = 11;
const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Reads a theme token from the document, so the terminal follows the active theme. */
function tokenColour(root: HTMLElement, token: Parameters<typeof themeVariable>[0]): string {
  return getComputedStyle(root).getPropertyValue(themeVariable(token)).trim();
}

export function TerminalView({
  onData,
  onReady,
  ref,
  fontSize = DEFAULT_FONT_SIZE,
  className,
  ...props
}: TerminalViewProps) {
  const mount = useRef<HTMLDivElement | null>(null);
  const handle = useRef<TerminalHandle | undefined>(undefined);
  const dataRef = useRef<((text: string) => void) | undefined>(onData);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    dataRef.current = onData;
  });

  useImperativeHandle(ref, () => ({
    write: (data) => handle.current?.write(data),
    reset: () => handle.current?.reset(),
  }));

  useEffect(() => {
    const element = mount.current;
    if (element === null) return;
    let disposed = false;
    let dispose = (): void => undefined;

    void (async () => {
      const [{ Terminal }] = await Promise.all([import('@xterm/xterm'), import('@xterm/xterm/css/xterm.css')]);
      if (disposed) return;
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: FONT_STACK,
        fontSize,
        allowTransparency: true,
        // Taken from the document's own custom properties rather than written
        // here, so a theme switch is the only place a colour is ever decided.
        theme: {
          background: tokenColour(element, 'deep'),
          foreground: tokenColour(element, 'dim'),
          cursor: tokenColour(element, 'hi'),
          selectionBackground: tokenColour(element, 'selected'),
        },
      });
      terminal.open(element);
      terminal.onData((text) => dataRef.current?.(text));
      handle.current = {
        write: (data) => terminal.write(data),
        reset: () => terminal.reset(),
      };
      setReady(true);
      onReady?.();

      dispose = () => {
        handle.current = undefined;
        terminal.dispose();
      };
    })();

    return () => {
      disposed = true;
      dispose();
    };
    // The emulator is built once for the life of the surface; later prop
    // changes reach it through the refs above rather than rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={mount}
      data-slot="terminal-view"
      data-ready={ready}
      className={cn('h-full w-full', className)}
      {...props}
    />
  );
}
