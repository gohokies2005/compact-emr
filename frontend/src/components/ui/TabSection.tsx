import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// The one container every case/chart tab uses — replaces the 5 different wrappers (bare divide-y, bordered
// table, p-6 shadow card, bordered list, Card). White-on-foam, aegis border, soft radius, optional header
// with a right-aligned action slot. The body's `divide-y divide-aegis` separates every list row identically
// with no per-tab effort.
export function TabSection({ title, description, action, children, className, bodyClassName }: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
}) {
  return (
    <section className={twMerge(clsx('overflow-hidden rounded-2xl border border-aegis bg-ivory shadow-aegis-card', className))}>
      {title || action ? (
        <header className="flex items-start justify-between gap-4 border-b border-aegis px-5 py-4">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold tracking-tight text-navyDeep">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-sm text-steel">{description}</p> : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      <div className={twMerge(clsx('divide-y divide-aegis', bodyClassName))}>{children}</div>
    </section>
  );
}
