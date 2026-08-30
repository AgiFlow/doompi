import {
  Button,
  CloseIcon,
  Kbd,
  OptionLabel,
  OptionRow,
  PlusIcon,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverFooter,
  StopIcon,
  Textarea,
} from '@agimon-ai/doompi-web-components';
import { useCallback, useEffect, useRef, useState } from 'react';
import { searchSessionFiles } from '../../lib/hubApi.ts';
import type { QueuedEntry } from '../../lib/sessionModel.ts';
import { HOST_SLOTS } from '../../lib/pluginRegistry.ts';
import { registerPromptInput } from '../../lib/promptFocus.ts';
import { abortRun, queueFollowUp, submitMessage, useActiveSession } from '../../stores/sessionStore.ts';
import { activeSessionId, useActiveSessionMeta } from '../../stores/sessionsStore.ts';
import { openPalette } from '../../stores/paletteStore.ts';
import { useToolPrompt } from '../../stores/useToolPrompt.ts';
import { PluginSurface } from '../../components/PluginSurface.tsx';
import { ComposerPrompt } from './ComposerPrompt.tsx';
import { QueueSheet } from './QueueSheet.tsx';

/** The input grows with the draft up to this many pixels, then scrolls. */
const MAX_INPUT_HEIGHT_PX = 192;
const MAX_COMPLETION_ITEMS = 8;
const FILE_SEARCH_DEBOUNCE_MS = 150;
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 100 * 1024;
const MAX_TOTAL_TEXT_BYTES = 200 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_EXTENSIONS = new Set([
  'c',
  'cpp',
  'css',
  'csv',
  'go',
  'h',
  'hpp',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsonl',
  'jsx',
  'log',
  'md',
  'markdown',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
]);
const FILE_INPUT_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,text/*,.json,.jsonl,.md,.markdown,.yaml,.yml,.toml,.ini,.log,.csv,.tsv,.xml,.html,.css,.js,.jsx,.ts,.tsx,.sh,.py,.rb,.rs,.go,.java,.c,.h,.cpp,.hpp,.sql';

interface ImageAttachment {
  id: string;
  kind: 'image';
  name: string;
  size: number;
  dataUrl: string;
  data: string;
  mimeType: string;
}

interface TextAttachment {
  id: string;
  kind: 'text';
  name: string;
  size: number;
  content: string;
}

type ComposerAttachment = ImageAttachment | TextAttachment;

function isReadableText(file: File): boolean {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  return file.type.startsWith('text/') || TEXT_EXTENSIONS.has(extension);
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('No file data'));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function attachmentPrompt(draft: string, attachments: ComposerAttachment[]): string {
  const parts: string[] = [];
  const trimmed = draft.trim();
  if (trimmed) parts.push(trimmed);
  for (const attachment of attachments) {
    if (attachment.kind !== 'text') continue;
    const safeName = attachment.name.replace(/[\r\n]/g, ' ').slice(0, 200);
    parts.push(`Attached file "${safeName}":\n\n${attachment.content}`);
  }
  if (parts.length === 0 && attachments.some((attachment) => attachment.kind === 'image')) {
    parts.push('Please review the attached image.');
  }
  return parts.join('\n\n');
}

interface CompletionItem {
  /** What replaces the trigger token when accepted. */
  insert: string;
  label: string;
  detail?: string;
}

interface CompletionState {
  kind: 'command' | 'file';
  /** Index of the trigger character in the draft. */
  tokenStart: number;
  query: string;
  items: CompletionItem[];
  selected: number;
}

/**
 * Whether accepting the highlighted item would leave the draft as it is. The
 * popup still shows what a longer name would complete to, but the keystroke
 * that would change nothing is handed back to the composer to send.
 */
function isCompletionRedundant(state: CompletionState): boolean {
  const item = state.items[state.selected];
  return item !== undefined && item.insert.trimEnd() === `${state.kind === 'command' ? '/' : '@'}${state.query}`;
}

/** The /command or @file token the caret sits in, or null when there is none. */
function triggerTokenAt(
  draft: string,
  caret: number,
): { kind: 'command' | 'file'; start: number; query: string } | null {
  const before = draft.slice(0, caret);
  const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1;
  const token = before.slice(start);
  if (token.startsWith('/') && start === 0) return { kind: 'command', start, query: token.slice(1) };
  if (token.startsWith('@') && token.length <= 64) return { kind: 'file', start, query: token.slice(1) };
  return null;
}

export function Composer() {
  const meta = useActiveSessionMeta();
  const streaming = useActiveSession((state) => state.streaming);
  const queuedEntries = useActiveSession((state) =>
    state.entries.filter((entry): entry is QueuedEntry => entry.kind === 'queued'),
  );
  const commands = useActiveSession((state) => state.commands);
  const editorTextRequest = useActiveSession((state) => state.editorTextRequest);
  const prompt = useToolPrompt();
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<number | null>(null);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [draggingFiles, setDraggingFiles] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const attachmentId = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const attached = meta?.attach === 'attached';
  const queued = Math.max(meta?.summary.pendingMessageCount ?? 0, queuedEntries.length);

  // Overlays hand the keyboard back here when they close. Re-registered when
  // a tool prompt stands the input down and again when it gives it back:
  // otherwise the ref stays as it was and every later hand-back goes nowhere.
  useEffect(() => registerPromptInput(inputRef.current), [prompt]);

  useEffect(() => {
    if (editorTextRequest === null) return;
    setDraft(editorTextRequest.text);
    setCaret(editorTextRequest.text.length);
    setDismissedToken(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(editorTextRequest.text.length, editorTextRequest.text.length);
    });
  }, [editorTextRequest]);

  // Auto-grow: measure after every draft change so pasted stack traces are
  // actually visible instead of scrolling inside one line.
  const resize = useCallback((): void => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${String(Math.min(input.scrollHeight, MAX_INPUT_HEIGHT_PX))}px`;
  }, []);
  useEffect(() => resize(), [draft, resize]);

  const closeCompletion = useCallback((): void => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setCompletion(null);
  }, []);

  /** Esc dismisses the popup for the token being typed; edits re-arm it. */
  const dismissCompletion = useCallback((): void => {
    const trigger = triggerTokenAt(draft, caret);
    setDismissedToken(trigger?.start ?? null);
    closeCompletion();
  }, [draft, caret, closeCompletion]);

  // The popup is derived state: any change to the draft, caret, session
  // commands, or attachment recomputes it, so data arriving after a keystroke
  // still opens it.
  useEffect(() => {
    const trigger = triggerTokenAt(draft, caret);
    if (!trigger || !attached || dismissedToken === trigger.start) {
      closeCompletion();
      return;
    }
    if (trigger.kind === 'command') {
      const items = commands
        .filter((command) => command.name.toLowerCase().startsWith(trigger.query.toLowerCase()))
        .slice(0, MAX_COMPLETION_ITEMS)
        .map((command) => ({ insert: `/${command.name} `, label: `/${command.name}`, detail: command.description }));
      setCompletion(
        items.length > 0
          ? { kind: 'command', tokenStart: trigger.start, query: trigger.query, items, selected: 0 }
          : null,
      );
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const sessionId = activeSessionId();
      if (sessionId === null) return;
      void searchSessionFiles(sessionId, trigger.query).then((files) => {
        // The draft may have moved on while the lookup ran.
        const input = inputRef.current;
        if (!input || triggerTokenAt(input.value, input.selectionStart)?.query !== trigger.query) return;
        const items = files.slice(0, MAX_COMPLETION_ITEMS).map((file) => ({ insert: `@${file} `, label: `@${file}` }));
        setCompletion(
          items.length > 0
            ? { kind: 'file', tokenStart: trigger.start, query: trigger.query, items, selected: 0 }
            : null,
        );
      });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [draft, caret, commands, attached, dismissedToken, closeCompletion]);

  // Clicking anywhere outside the composer closes the popup.
  useEffect(() => {
    if (!completion) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) {
        closeCompletion();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [completion, closeCompletion]);

  const accept = (state: CompletionState, index: number): void => {
    const item = state.items[index];
    if (!item) return;
    const next = draft.slice(0, state.tokenStart) + item.insert + draft.slice(caret);
    setDraft(next);
    const position = state.tokenStart + item.insert.length;
    setCaret(position);
    setDismissedToken(state.tokenStart);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  };

  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      const next = [...attachments];
      const rejected: string[] = [];
      let imageBytes = next.reduce((total, item) => total + (item.kind === 'image' ? item.size : 0), 0);
      let textBytes = next.reduce((total, item) => total + (item.kind === 'text' ? item.size : 0), 0);

      for (const file of files) {
        if (next.length >= MAX_ATTACHMENTS) {
          rejected.push(`Only ${String(MAX_ATTACHMENTS)} attachments are allowed.`);
          break;
        }
        const id = `attachment-${String(attachmentId.current++)}`;
        if (IMAGE_TYPES.has(file.type)) {
          if (file.size > MAX_IMAGE_BYTES) {
            rejected.push(`${file.name} exceeds the 10 MB image limit.`);
            continue;
          }
          if (imageBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
            rejected.push(`${file.name} exceeds the 20 MB total image limit.`);
            continue;
          }
          try {
            const dataUrl = await readDataUrl(file);
            next.push({
              id,
              kind: 'image',
              name: file.name,
              size: file.size,
              dataUrl,
              data: dataUrl.slice(dataUrl.indexOf(',') + 1),
              mimeType: file.type,
            });
            imageBytes += file.size;
          } catch {
            rejected.push(`${file.name} could not be read.`);
          }
          continue;
        }
        if (!isReadableText(file)) {
          rejected.push(`${file.name} is not a supported image or text file.`);
          continue;
        }
        if (file.size > MAX_TEXT_BYTES) {
          rejected.push(`${file.name} exceeds the 100 KB text file limit.`);
          continue;
        }
        if (textBytes + file.size > MAX_TOTAL_TEXT_BYTES) {
          rejected.push(`${file.name} exceeds the 200 KB total text limit.`);
          continue;
        }
        try {
          next.push({ id, kind: 'text', name: file.name, size: file.size, content: await file.text() });
          textBytes += file.size;
        } catch {
          rejected.push(`${file.name} could not be read.`);
        }
      }
      setAttachments(next);
      setAttachmentError(rejected.join(' '));
    },
    [attachments],
  );

  const clearAfterSend = (): void => {
    setDraft('');
    setAttachments([]);
    setAttachmentError('');
    setCaret(0);
    setDismissedToken(null);
    closeCompletion();
  };

  const submit = (): void => {
    if ((!draft.trim() && attachments.length === 0) || !attached) return;
    const message = attachmentPrompt(draft, attachments);
    const images = attachments
      .filter((attachment): attachment is ImageAttachment => attachment.kind === 'image')
      .map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }));
    submitMessage(message, images);
    clearAfterSend();
  };

  const queue = (): void => {
    if ((!draft.trim() && attachments.length === 0) || !attached) return;
    const message = attachmentPrompt(draft, attachments);
    const images = attachments
      .filter((attachment): attachment is ImageAttachment => attachment.kind === 'image')
      .map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }));
    queueFollowUp(message, images);
    clearAfterSend();
  };

  const placeholder = !attached
    ? 'waiting for the session…'
    : streaming
      ? 'steer the run without stopping it…'
      : 'ask anything · / for commands · @ for files…';

  // A tool waiting on an answer takes the input's place rather than opening
  // over the conversation: the transcript is what the reader needs in order
  // to answer, and there is nothing to type here until the agent is unblocked.
  if (prompt !== null) {
    return (
      <div className="shrink-0 border-t border-doom-border bg-doom-rail px-3 pt-3 pb-2.5 sm:px-5">
        <QueueSheet count={queued} entries={queuedEntries} />
        <div className="rounded-lg border border-doom-edge-magenta bg-doom-deep">
          <ComposerPrompt claim={prompt} sessionId={activeSessionId()} />
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-doom-border bg-doom-rail px-3 pt-3 pb-2.5 sm:px-5">
      <QueueSheet count={queued} entries={queuedEntries} />
      <Popover
        open={completion !== null}
        onOpenChange={(next) => {
          if (!next) dismissCompletion();
        }}
      >
        <PopoverAnchor asChild>
          <div
            ref={containerRef}
            onDragOver={(event) => {
              if (!attached || !event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              setDraggingFiles(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);
            }}
            onDrop={(event) => {
              setDraggingFiles(false);
              if (!attached || event.dataTransfer.files.length === 0) return;
              event.preventDefault();
              void addFiles(Array.from(event.dataTransfer.files));
            }}
            className={`relative rounded-lg border bg-doom-deep transition-colors focus-within:border-doom-blue/60 ${
              draggingFiles
                ? 'border-doom-blue bg-doom-blue/5'
                : streaming
                  ? 'border-doom-edge-yellow'
                  : 'border-doom-border'
            }`}
          >
            {/* prefer-shared-primitive: ignore -- a hidden native file picker has no visual primitive. */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={FILE_INPUT_ACCEPT}
              tabIndex={-1}
              className="hidden"
              data-testid="composer-file-input"
              onChange={(event) => {
                void addFiles(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = '';
              }}
            />
            {completion ? (
              <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                data-testid="composer-completion"
                // The keys belong to the textarea, so the menu never takes
                // focus; a click in the composer is a caret move, not a
                // dismissal, which is why the anchor is exempt from outside.
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
                onInteractOutside={(event) => {
                  if (containerRef.current?.contains(event.target as Node) === true) event.preventDefault();
                }}
                className="w-[420px] max-w-[85vw] rounded-md p-0 shadow-xl"
              >
                {completion.items.map((item, index) => (
                  <OptionRow
                    key={item.label}
                    density="compact"
                    active={index === completion.selected}
                    data-testid={`composer-completion-item-${String(index)}`}
                    onMouseEnter={() => setCompletion({ ...completion, selected: index })}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      accept(completion, index);
                    }}
                    className="w-full items-baseline gap-2.5 rounded-none px-3 py-1.5"
                  >
                    <span className="shrink-0 text-[12px] font-bold text-doom-blue">{item.label}</span>
                    {item.detail ? (
                      <OptionLabel density="compact" className="text-[10px] text-doom-dim">
                        {item.detail}
                      </OptionLabel>
                    ) : null}
                  </OptionRow>
                ))}
                <PopoverFooter className="py-1">
                  <span className="flex items-center gap-1.5">
                    <Kbd>tab</Kbd> or <Kbd>enter</Kbd> completes · <Kbd>esc</Kbd> closes
                  </span>
                </PopoverFooter>
              </PopoverContent>
            ) : null}
            <div className="flex min-w-0 items-start gap-2 px-2.5 pt-3 sm:gap-2.5 sm:px-3.5">
              <span className="mt-[3px] shrink-0 select-none text-[13px] leading-none text-doom-green">&gt;</span>
              <Textarea
                variant="bare"
                ref={inputRef}
                data-testid="composer-input"
                value={draft}
                disabled={!attached}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setCaret(event.target.selectionStart);
                  setDismissedToken(null);
                }}
                onClick={(event) => setCaret(event.currentTarget.selectionStart)}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files);
                  if (files.length === 0) return;
                  event.preventDefault();
                  void addFiles(files);
                }}
                onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
                onKeyDown={(event) => {
                  // The TUI's leader key: space with nothing typed opens Leader Space.
                  if (event.key === ' ' && draft === '') {
                    event.preventDefault();
                    openPalette();
                    return;
                  }
                  if (completion) {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      const delta = event.key === 'ArrowDown' ? 1 : -1;
                      const count = completion.items.length;
                      setCompletion({ ...completion, selected: (completion.selected + delta + count) % count });
                      return;
                    }
                    if (event.key === 'Tab') {
                      event.preventDefault();
                      accept(completion, completion.selected);
                      return;
                    }
                    // Enter completes, unless the token is already the whole
                    // thing: completing then would only add a space, so the
                    // keystroke would read as doing nothing and the reader would
                    // have to press enter twice to send what they had typed.
                    if (event.key === 'Enter' && !isCompletionRedundant(completion)) {
                      event.preventDefault();
                      accept(completion, completion.selected);
                      return;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      dismissCompletion();
                      return;
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                  if (event.key === 'Escape' && streaming) {
                    event.preventDefault();
                    abortRun();
                  }
                }}
                rows={1}
                placeholder={placeholder}
                className="min-h-[20px] min-w-0 flex-1 text-[13px] leading-relaxed"
              />
            </div>
            {attachments.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 px-3.5 pt-2" data-testid="composer-attachments">
                {attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    data-testid={`composer-attachment-${attachment.id}`}
                    className="flex max-w-full items-center gap-1.5 rounded border border-doom-border bg-doom-panel px-1.5 py-1 text-[10px] text-doom-dim"
                  >
                    {attachment.kind === 'image' ? (
                      <img src={attachment.dataUrl} alt="" className="h-6 w-6 rounded object-cover" />
                    ) : (
                      <span className="font-bold text-doom-blue">TXT</span>
                    )}
                    <span className="max-w-40 truncate">{attachment.name}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`remove ${attachment.name}`}
                      className="h-4 w-4 min-w-4 text-doom-faint hover:text-doom-text"
                      onClick={() => {
                        setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                        setAttachmentError('');
                      }}
                    >
                      <CloseIcon className="h-2.5 w-2.5" />
                    </Button>
                  </span>
                ))}
              </div>
            ) : null}
            {attachmentError ? (
              <p
                role="alert"
                data-testid="composer-attachment-error"
                className="px-3.5 pt-1.5 text-[10px] text-doom-red"
              >
                {attachmentError}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 px-2.5 pt-2 pb-2.5 sm:flex-nowrap sm:px-3.5">
              <span data-testid="composer-hint" className="text-[10px] text-doom-faint max-sm:hidden">
                {streaming
                  ? 'enter steers the run · esc aborts'
                  : 'enter sends · shift+enter for a new line · space opens leader'}
              </span>
              <Button
                variant="ghost"
                size="icon"
                data-testid="composer-attach"
                disabled={!attached}
                title="attach images or text files"
                aria-label="attach images or text files"
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 text-doom-dim"
              >
                <PlusIcon className="h-3 w-3" />
              </Button>
              <span className="min-w-0 flex-1" />
              {streaming ? (
                <Button variant="danger-outline" size="md" data-testid="composer-abort" onClick={() => abortRun()}>
                  <StopIcon className="h-2 w-2 fill-current" />
                  abort
                </Button>
              ) : null}
              <span className="contents sm:hidden" data-testid="composer-mobile-actions">
                <PluginSurface slot={HOST_SLOTS.composerActions} sessionId={activeSessionId()} />
              </span>
              <Button
                variant="outline"
                size="md"
                data-testid="composer-queue"
                onClick={queue}
                disabled={!attached || (!draft.trim() && attachments.length === 0)}
                title="deliver after the current run settles"
              >
                queue
              </Button>
              <Button
                variant="primary"
                size="md"
                data-testid="composer-send"
                onClick={submit}
                disabled={!attached || (!draft.trim() && attachments.length === 0)}
                className="px-2.5 sm:px-3.5"
              >
                {streaming ? 'steer' : 'send'}
              </Button>
            </div>
          </div>
        </PopoverAnchor>
      </Popover>
    </div>
  );
}
