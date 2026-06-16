import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * SectionCard — the ONE consistent container for Overview "story" sections (2026-06-16, Ryan's
 * calm/neutral direction). Quiet neutral card: thin slate border, white bg, uniform padding, a
 * single title size. Color belongs ONLY in the small `status` chip slot (top-right), never the
 * container — that's what keeps the page calm. Every Overview section uses this so titles, padding,
 * borders, and spacing are identical instead of the prior ragged mix of filled bubbles.
 */
export function SectionCard({
  title,
  status,
  children,
  className,
}: {
  /** Section heading (e.g. "Assessment"). Omit for a chrome-less card. */
  readonly title?: ReactNode;
  /** Small status chip rendered top-right (the only place color lives). */
  readonly status?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={twMerge(clsx('rounded-lg border border-slate-200 bg-white p-5', className))}>
      {title !== undefined || status !== undefined ? (
        <div className="mb-2 flex items-start justify-between gap-3">
          {title !== undefined ? <h2 className="text-sm font-semibold text-navyDeep">{title}</h2> : <span />}
          {status !== undefined ? <div className="shrink-0">{status}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
