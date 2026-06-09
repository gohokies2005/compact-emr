import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// The one row every list uses — same padding, same hover, same 3-zone layout: lead (primary) · meta
// (secondary, muted) · trailing (chip + actions). Pass `onClick` to make the whole row a button
// (documents, draft jobs, email). This is the heart of the cross-tab unification.
export function DataRow({ lead, meta, trailing, onClick, className }: {
  readonly lead: ReactNode;
  readonly meta?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onClick?: () => void;
  readonly className?: string;
}) {
  const base = 'flex items-center gap-4 px-5 py-3.5 text-sm transition-colors';
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-slateInk">{lead}</div>
        {meta ? <div className="mt-0.5 truncate text-xs text-steel">{meta}</div> : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-3">{trailing}</div> : null}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={twMerge(clsx(base, 'w-full text-left hover:bg-mistSoft', className))}>
      {body}
    </button>
  ) : (
    <div className={twMerge(clsx(base, className))}>{body}</div>
  );
}
