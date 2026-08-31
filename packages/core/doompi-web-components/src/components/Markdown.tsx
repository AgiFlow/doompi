import { createContext, type ComponentProps, useContext } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const REMARK_PLUGINS = [remarkGfm];

const CODE_CLASS = 'rounded bg-doom-deep px-1 py-px font-mono text-[12px] text-doom-green';

/**
 * What a piece of inline code opens, when the host knows.
 *
 * Returning undefined leaves the span as plain code, which is the answer for
 * everything a message quotes that is not a file: a class name, a flag, a
 * command. The caller decides what counts, because only it knows which files
 * the session has.
 */
export type FileLinkHandler = (text: string) => (() => void) | undefined;

/**
 * Passed by context rather than as a component prop so the component map stays
 * a module constant. Rebuilding that map per render gives react-markdown new
 * component identities, which remounts the whole rendered tree on every frame
 * of a streaming reply.
 */
const FileLinkContext = createContext<FileLinkHandler | undefined>(undefined);

function Code({ className, children, ...rest }: ComponentProps<'code'>) {
  const onFileLink = useContext(FileLinkContext);
  // Only a single-line span with no language class is a candidate: a fenced
  // block is content, not a reference, and its own renderer owns it.
  const label = typeof children === 'string' && !children.includes('\n') ? children : undefined;
  const open = label === undefined || className !== undefined ? undefined : onFileLink?.(label);
  if (open !== undefined && label !== undefined) {
    return (
      <button
        type="button"
        data-testid="markdown-file-link"
        title={`open ${label}`}
        onClick={open}
        className={`${CODE_CLASS} cursor-pointer underline decoration-doom-green/40 underline-offset-2 hover:text-doom-hi hover:decoration-doom-hi`}
      >
        {label}
      </button>
    );
  }
  return (
    <code
      {...rest}
      className={`${className ?? ''} ${CODE_CLASS} [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-doom-hi`}
    >
      {children}
    </code>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="whitespace-pre-wrap break-words">{children}</p>,
  strong: ({ children }) => <strong className="font-bold text-doom-hi">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-doom-dim line-through">{children}</del>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-doom-blue underline decoration-doom-blue/50">
      {children}
    </a>
  ),
  code: Code,
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded border border-doom-border bg-doom-deep p-2.5 text-[12px] leading-relaxed">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="whitespace-pre-wrap break-words">{children}</li>,
  h1: ({ children }) => <h1 className="text-[15px] font-bold text-doom-hi">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[14px] font-bold text-doom-hi">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[13px] font-bold text-doom-hi">{children}</h3>,
  h4: ({ children }) => <h4 className="text-[13px] font-bold text-doom-text">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-doom-border pl-3 text-doom-dim">{children}</blockquote>
  ),
  hr: () => <hr className="border-doom-border-soft" />,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-doom-border bg-doom-deep px-2 py-1 text-left font-bold text-doom-hi">{children}</th>
  ),
  td: ({ children }) => <td className="border border-doom-border px-2 py-1 align-top">{children}</td>,
  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ''} className="max-h-[480px] max-w-full rounded border border-doom-border" />
  ),
};

/** GitHub-flavored Markdown using the cockpit's safe, shared presentation. */
export function Markdown({ text, onFileLink }: { text: string; onFileLink?: FileLinkHandler }) {
  return (
    <FileLinkContext.Provider value={onFileLink}>
      <div className="flex min-w-0 flex-col gap-2">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </FileLinkContext.Provider>
  );
}
