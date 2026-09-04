import type { AuthorRequestRecord } from './authorViewportTypes.ts';

export function AuthorRequestLog({ requests }: { requests: readonly AuthorRequestRecord[] }) {
  return (
    <section data-testid="author-request-history" className="space-y-2 border-t border-doom-border pt-3">
      <h3 className="text-[10px] text-doom-faint">session history</h3>
      <ol className="space-y-3">
        {requests.map((request) => (
          <li key={request.id} className="space-y-1 text-[11px] text-doom-text">
            <strong>{request.status}</strong>
            <p>{request.requestText}</p>
            {request.currentOperation ? <p>{request.currentOperation}</p> : null}
            {request.before !== undefined ? <pre className="whitespace-pre-wrap">before: {request.before}</pre> : null}
            {request.after !== undefined ? <pre className="whitespace-pre-wrap">after: {request.after}</pre> : null}
            {request.error ? <p className="text-doom-red">{request.error}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
