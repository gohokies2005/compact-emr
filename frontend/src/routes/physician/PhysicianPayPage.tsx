import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { BridgeRotation } from '../../components/BridgeRotation';
import { getMyPay, getMyPayMonths } from '../../api/pay';

/**
 * Track pay — physician self-serve earnings (docs/DOCTOR_PAY_BUILD_PLAN_2026-06-11.md §6.2).
 * ACCURACY-CRITICAL: the total row is the physician's expected check. All math is server-side
 * (pay-earnings.ts, adversarially matrix-tested); this page only selects a month and renders.
 * Months are PACIFIC calendar months — payroll runs on the 1st, Pacific (locked decision E).
 */

const PAY_TIMEZONE = 'America/Los_Angeles';

/** Current 'YYYY-MM' in the payroll timezone (the page's default selection). */
function currentPacificMonth(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: PAY_TIMEZONE, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}

/** 'YYYY-MM' → 'June 2026' (formatted in UTC off mid-month so no TZ can shift the label). */
function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) return month;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15));
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** Integer cents → '$x.xx'. Cents-only on the wire; never float math in the UI (plan §6.2). */
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** ISO timestamp → 'Jun 15, 2026' in the payroll (Pacific) timezone. The pay row's
 *  firstApprovedAt IS the physician sign-off/approval moment that completed the letter. */
function formatSignedDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: PAY_TIMEZONE }).format(d);
}

const LETTER_TYPE_LABELS: Record<string, string> = {
  nexus_letter: 'Nexus letter',
  nexus_memo: 'Nexus memo',
};

export function PhysicianPayPage() {
  // Default to the current PT month — what Ryan's payroll run looks at next.
  const [month, setMonth] = useState<string>(() => currentPacificMonth());

  const monthsQuery = useQuery({
    queryKey: ['pay', 'months'],
    queryFn: () => getMyPayMonths(),
  });
  const payQuery = useQuery({
    queryKey: ['pay', 'me', month],
    queryFn: () => getMyPay(month),
  });

  const rows = payQuery.data?.rows ?? [];
  const totalCents = payQuery.data?.totalCents ?? 0;
  // Dropdown: All + every PT month since employment start (server-enumerated, descending).
  const months = monthsQuery.data ?? [currentPacificMonth()];
  const isAll = month === 'all';
  const totalLabel = isAll ? 'Career total' : `Expected check (${monthLabel(month)})`;

  return (
    <AppShell>
      {/* Same ambient bridge band as the other MAIN physician tabs (Queue / Completed Letters);
          never mounts inside a claim/letter view. Wrapper mirrors PhysicianLettersPage. */}
      <section className="relative mb-8 overflow-hidden rounded-2xl border border-aegis shadow-aegis-card">
        <BridgeRotation caption={false} className="h-40 sm:h-48">
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-navyDeep/85 via-navyDeep/50 to-transparent" />
          <div className="relative flex h-full flex-col justify-center px-7">
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-brassSoft">Aegis</p>
            <h1 className="mt-1 text-2xl font-semibold text-white sm:text-3xl">Track Pay</h1>
            <p className="mt-1 text-sm text-white/75">Completed-letter earnings by month — Pacific calendar months</p>
          </div>
        </BridgeRotation>
      </section>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <label className="block text-sm sm:w-64">
          <span className="mb-1 block font-medium text-slate-700">Month</span>
          <select
            className="input"
            aria-label="Pay month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          >
            <option value="all">All</option>
            {months.map((m) => (
              <option key={m} value={m}>{monthLabel(m)}</option>
            ))}
          </select>
        </label>
      </div>

      <Card className="p-0">
        {payQuery.isLoading ? (
          <div className="p-6">
            <Spinner label="Loading pay" />
          </div>
        ) : payQuery.isError ? (
          <div className="p-6">
            <EmptyState title="Could not load pay" message="Your earnings failed to load. Reload the page or try another month." />
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Veteran name</th>
                  <th className="px-4 py-3">Condition</th>
                  <th className="px-4 py-3">Letter type</th>
                  <th className="px-4 py-3">Date signed</th>
                  <th className="px-4 py-3 text-right">Pay</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={`${r.caseId}-${r.letterType}`}>
                    <td className="px-4 py-3 font-medium text-slate-900">{r.veteranName || '—'}</td>
                    <td className="px-4 py-3 text-slate-700">{r.condition}</td>
                    <td className="px-4 py-3 text-slate-600">{LETTER_TYPE_LABELS[r.letterType] ?? r.letterType}</td>
                    <td className="px-4 py-3 text-slate-600">{formatSignedDate(r.firstApprovedAt)}</td>
                    <td className="px-4 py-3 text-right font-medium text-slate-800">{formatCents(r.payCents)}</td>
                  </tr>
                ))}
              </tbody>
              {/* The expected-check row renders even at $0 — an empty month must read as a real $0.00,
                  never a blank screen (adversarial test Z). */}
              <tfoot className="border-t border-slate-200 bg-slate-50 text-sm font-semibold text-slate-900">
                <tr>
                  <td className="px-4 py-3" colSpan={4}>{totalLabel}</td>
                  <td className="px-4 py-3 text-right">{formatCents(totalCents)}</td>
                </tr>
              </tfoot>
            </table>
            {rows.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No completed letters"
                  message={isAll ? 'No completed letters yet. Approved letters appear here with their pay.' : `No completed letters in ${monthLabel(month)}.`}
                />
              </div>
            ) : null}
          </div>
        )}
      </Card>
    </AppShell>
  );
}
