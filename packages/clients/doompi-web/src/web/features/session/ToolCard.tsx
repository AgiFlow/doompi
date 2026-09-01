import {
  collapseLines,
  MessageItem,
  MessageItemBody,
  MessageItemHeader,
  MessageItemStatus,
  type StatusTone,
} from '@agimon-ai/doompi-web-components';
import { ToolRendererBoundary } from '../../components/ToolRendererBoundary.tsx';
import { pluginToolRenderer } from '../../lib/pluginRegistry.ts';
import { imagesFromContent, type ToolEntry } from '../../lib/sessionModel.ts';
import { toolMessageProps } from '../../lib/toolMessageProps.ts';
import { useActiveSession } from '../../stores/sessionStore.ts';
import { usePluginSlotProps } from '../../stores/usePluginSlotProps.ts';

const MAX_PREVIEW_LINES = 12;

type AttachmentKind = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'file';

interface HostAttachment {
  kind: AttachmentKind;
  mimeType: string;
  name: string;
  data?: string;
  text?: string;
  uri?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/')) return 'text';
  return 'file';
}

function attachmentName(block: Record<string, unknown>, index: number): string {
  for (const key of ['title', 'name', 'filename', 'fileName']) {
    if (typeof block[key] === 'string' && block[key].length > 0) return block[key];
  }
  if (typeof block.uri === 'string' && block.uri.length > 0) return block.uri.split('/').at(-1) || block.uri;
  return `attachment-${String(index + 1)}`;
}

/** Binary and linked result blocks a tool returned outside its ordinary text. */
function hostAttachments(entry: ToolEntry): HostAttachment[] {
  const content = entry.result?.content ?? [];
  const images: HostAttachment[] = imagesFromContent(content).map((image, index) => ({
    kind: 'image',
    mimeType: image.mimeType,
    name: `${entry.name}-result-${String(index + 1)}`,
    data: image.data,
  }));
  const details = isRecord(entry.result?.details) ? entry.result.details : undefined;
  const blocks = [...content, ...(Array.isArray(details?.blocks) ? details.blocks : [])];
  const other = blocks.flatMap((candidate, index): HostAttachment[] => {
    if (!isRecord(candidate) || candidate.type === 'text' || candidate.type === 'image') return [];
    const resource = candidate.type === 'resource' && isRecord(candidate.resource) ? candidate.resource : candidate;
    const mimeType = typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream';
    const data =
      typeof resource.data === 'string' ? resource.data : typeof resource.blob === 'string' ? resource.blob : undefined;
    const text = typeof resource.text === 'string' ? resource.text : undefined;
    const uri = typeof resource.uri === 'string' ? resource.uri : undefined;
    if (data === undefined && text === undefined && uri === undefined) return [];
    return [{ kind: attachmentKind(mimeType), mimeType, name: attachmentName(resource, index), data, text, uri }];
  });
  return [...images, ...other];
}

function attachmentUrl(attachment: HostAttachment): string | undefined {
  if (attachment.data !== undefined) return `data:${attachment.mimeType};base64,${attachment.data}`;
  if (attachment.uri === undefined) return undefined;
  return /^(?:https?):\/\//u.test(attachment.uri) ? attachment.uri : undefined;
}

function HostAttachmentView({ attachment, index }: { attachment: HostAttachment; index: number }) {
  const url = attachmentUrl(attachment);
  if (attachment.kind === 'text' && attachment.text !== undefined) {
    return (
      <pre
        data-testid="tool-output-text-file"
        className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-doom-border-soft p-2"
      >
        {attachment.text}
      </pre>
    );
  }
  if (url !== undefined && attachment.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="self-start">
        <img
          src={url}
          alt={attachment.name}
          data-testid="tool-output-image"
          className="h-auto max-h-96 max-w-full rounded-md border border-doom-border-soft object-contain"
        />
      </a>
    );
  }
  if (url !== undefined && attachment.kind === 'video') {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        data-testid="tool-output-video"
        className="max-h-96 max-w-full self-start rounded-md border border-doom-border-soft"
      >
        <track kind="captions" />
      </video>
    );
  }
  if (url !== undefined && attachment.kind === 'audio') {
    return (
      <audio src={url} controls preload="metadata" data-testid="tool-output-audio" className="w-full">
        <track kind="captions" />
      </audio>
    );
  }
  if (url !== undefined && attachment.kind === 'pdf') {
    return (
      <iframe
        src={url}
        title={attachment.name}
        data-testid="tool-output-pdf"
        className="h-[480px] w-full rounded-md border border-doom-border-soft bg-doom-deep"
      />
    );
  }
  return url !== undefined ? (
    <a
      href={url}
      download={attachment.name}
      target="_blank"
      rel="noreferrer"
      data-testid="tool-output-file"
      className="self-start rounded-md border border-doom-border px-3 py-2 text-doom-blue hover:border-doom-blue/60"
    >
      {attachment.name} · {attachment.mimeType}
    </a>
  ) : (
    <span
      key={index}
      data-testid="tool-output-file"
      className="self-start rounded-md border border-doom-border px-3 py-2 text-doom-faint"
    >
      {attachment.name} · {attachment.mimeType}
    </span>
  );
}

function toneOf(entry: ToolEntry): StatusTone {
  return entry.running ? 'running' : entry.isError ? 'error' : 'ok';
}

/**
 * The host's own item for a tool no plugin claims: the argument summary in
 * the header and the result's text and safe browser previews, with long text
 * clipped until expanded, on the same shell every plugin message is built from.
 */
function HostToolMessage({ entry }: { entry: ToolEntry }) {
  const lines = entry.output.length > 0 ? entry.output.split('\n') : [];
  const attachments = hostAttachments(entry);
  return (
    <MessageItem tone={toneOf(entry)} expandable={lines.length > MAX_PREVIEW_LINES}>
      {({ expanded }) => {
        const { shown, hidden } = collapseLines(lines, MAX_PREVIEW_LINES, expanded);
        return (
          <>
            <MessageItemHeader title={entry.name}>
              <span className="min-w-0 flex-1 truncate">{entry.argSummary}</span>
            </MessageItemHeader>
            {shown.length > 0 || attachments.length > 0 ? (
              <MessageItemBody className="flex flex-col gap-2">
                {shown.length > 0 ? (
                  <pre data-testid="tool-output" className="whitespace-pre-wrap break-words">
                    {shown.join('\n')}
                  </pre>
                ) : null}
                {attachments.map((attachment, index) => (
                  <HostAttachmentView
                    key={`${attachment.mimeType}:${attachment.name}:${String(index)}`}
                    attachment={attachment}
                    index={index}
                  />
                ))}
                {hidden > 0 ? <MessageItemStatus expands>show {hidden} more line(s)</MessageItemStatus> : null}
              </MessageItemBody>
            ) : null}
          </>
        );
      }}
    </MessageItem>
  );
}

/**
 * One tool call in the timeline. The plugin that registered the tool owns
 * the whole item through its `message` renderer, the web half of the TUI's
 * renderShell 'self'; the host only marks the row, catches a renderer that
 * throws, and stands in for a tool nobody claims.
 */
export function ToolCard({ entry, sessionId }: { entry: ToolEntry; sessionId: string | null }) {
  const statuses = useActiveSession((state) => state.statuses);
  const slotProps = usePluginSlotProps(sessionId);
  const renderer = pluginToolRenderer(entry.name, statuses);
  const state = toneOf(entry);
  const props = toolMessageProps(slotProps, entry, statuses);
  return (
    <ToolRendererBoundary key={entry.toolCallId} toolName={entry.name}>
      {(failed) => (
        <div
          data-testid="entry-tool"
          data-tool-name={entry.name}
          data-tool-state={state}
          data-tool-renderer={failed ? 'failed' : renderer ? 'plugin' : 'host'}
        >
          {renderer && !failed ? <renderer.message {...props} /> : <HostToolMessage entry={entry} />}
        </div>
      )}
    </ToolRendererBoundary>
  );
}
