import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { CaseStatus } from '../../types/prisma';
import { CASE_STATUS_LABELS } from '../../lib/caseStatus';

const STATUS_CLASSES: Record<CaseStatus, string> = {
  intake: 'bg-slate-100 text-slate-700',
  records: 'bg-amber-100 text-amber-700',
  viability: 'bg-blue-100 text-blue-700',
  drafting: 'bg-purple-100 text-purple-700',
  rn_review: 'bg-indigo-100 text-indigo-700',
  physician_review: 'bg-pink-100 text-pink-700',
  correction_requested: 'bg-orange-100 text-orange-700',
  correction_review: 'bg-fuchsia-100 text-fuchsia-700',
  delivered: 'bg-emerald-100 text-emerald-700',
  paid: 'bg-emerald-200 text-emerald-900 font-semibold',
  rejected: 'bg-rose-100 text-rose-700',
};

export function CaseStatusBadge({ status, className }: { readonly status: CaseStatus; readonly className?: string }) {
  return <span className={twMerge(clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_CLASSES[status], className))}>{CASE_STATUS_LABELS[status]}</span>;
}
