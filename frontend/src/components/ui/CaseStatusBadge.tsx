import type { CaseStatus } from '../../types/prisma';
import { caseDisplayLabel } from '../../lib/caseStatus';
import { StatusChip, type ChipTone } from './StatusChip';

// The ~13 ad-hoc color pairs collapse onto the 6 shared Aegis chip tones. Prop API is unchanged
// (status + optional className) so every caller renders identically in behavior; only the visual
// palette moves to the design system.
const STATUS_TONES: Record<CaseStatus, ChipTone> = {
  intake: 'neutral',
  records: 'warn',
  viability: 'info',
  drafting: 'active',
  rn_review: 'info',
  physician_review: 'active',
  correction_requested: 'warn',
  correction_review: 'active',
  delivered: 'good',
  paid: 'good',
  rejected: 'bad',
  needs_rn_decision: 'warn',
  needs_records: 'warn',
};

export function CaseStatusBadge({ status, invoiced, className }: { readonly status: CaseStatus; readonly invoiced?: boolean | undefined; readonly className?: string }) {
  // Invoiced overlay (Ryan 2026-06-12): a delivered case with the invoice email out reads
  // "Invoiced" — SAME format, neutral tone (not the green 'good'), label change only.
  const isInvoiced = status === 'delivered' && invoiced === true;
  return <StatusChip tone={isInvoiced ? 'neutral' : STATUS_TONES[status]} {...(className ? { className } : {})}>{caseDisplayLabel(status, { invoiced })}</StatusChip>;
}
