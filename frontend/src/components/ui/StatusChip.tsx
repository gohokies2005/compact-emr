import type { ReactNode } from 'react';
import { clsx } from 'clsx';

// One chip vocabulary for the whole app — replaces the per-tab dialects (clarification pills, draft-state
// text, email direction chips, SC selects, case-status badge). Tone-driven, all in the Aegis palette.
export type ChipTone = 'neutral' | 'info' | 'active' | 'good' | 'warn' | 'bad';

const TONE: Record<ChipTone, string> = {
  neutral: 'bg-mist text-navyDeep',
  info: 'bg-mistSoft text-navy ring-1 ring-aegis',
  active: 'bg-navy/10 text-navyDeep',
  good: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100',
  warn: 'bg-amber-50 text-amber-700 ring-1 ring-amber-100',
  bad: 'bg-rose-50 text-rose-700 ring-1 ring-rose-100',
};

export function StatusChip({ tone = 'neutral', children, className }: {
  readonly tone?: ChipTone;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span className={clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', TONE[tone], className)}>
      {children}
    </span>
  );
}
