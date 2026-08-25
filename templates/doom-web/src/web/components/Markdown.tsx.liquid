import type { ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const REMARK_PLUGINS = [remarkGfm];

// Fenced code arrives as <pre><code>; inline code has no pre parent. The
// class each gets is decided here so both stay literal for Tailwind's scanner.
function Code({ className, children, ...rest }: ComponentProps<'code'>) {
  return (
    <code
      {...rest}
      className={`${className ?? ''} rounded bg-doom-deep px-1 py-px font-mono text-[12px] text-doom-green [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-doom-hi`}
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
    <img src={src} alt={alt ?? ''} className="max-h-[360px] max-w-full rounded border border-doom-border" />
  ),
};

/**
 * Message text as the agent means it: GitHub-flavoured markdown in the
 * cockpit's type scale. Soft line breaks stay visible, since a prompt typed
 * over several lines should read back the way it was written.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
