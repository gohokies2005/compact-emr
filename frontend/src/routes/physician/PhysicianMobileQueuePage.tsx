import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { listCases } from '../../api/cases';
import { getPhysicianMe } from '../../api/physicians';
import { formatRelativeTime } from '../../lib/date';
import { formatNameLastFirst, formatPhysicianLastName } from '../../lib/format';
import { timeOfDayGreeting } from '../../lib/greeting';

// PHYSICIAN MOBILE QUEUE (Ryan/Dr. Kasky 2026-06-25, foundation slice #80). A focused, mobile-first
// landing for a doctor on the move: "N letters waiting for you" + a tap-target card per case. This is
// the queue half of the dedicated mobile review/approve flow (/p/m/...). It deliberately reuses the
// SAME data source (listCases status=physician_review) and helpers as the desktop PhysicianQueuePage —
// only the layout differs (cards, not a wide table). The desktop pages are untouched.
//
// SCOPE: physician review/approve only. No RN tabs, no chart-extract, no intake/billing.
//
// "their cases": when the caller has a Physician row (/physicians/me) we filter the queue to the cases
// assigned to them (assignedPhysicianId). If /me 404s (no mapping) or the id is absent we fall back to
// the full physician_review queue (admin/coverage) — never an empty screen from a missing mapping.

export function PhysicianMobileQueuePage() {
  // retry:false — a 404 (no Physician mapping) must fall back gracefully, never block the queue.
  const meQuery = useQuery({ queryKey: ['physicians', 'me'], queryFn: getPhysicianMe, retry: false, staleTime: 60_000 });
  const physicianId = meQuery.data?.data.id ?? null;
  // Wait for /me to settle (success OR error) before firing the list, so we don't first show the
  // unfiltered queue and then re-filter (a flash). isLoading is false once it resolves either way.
  const meSettled = !meQuery.isLoading;

  const queueQuery = useQuery({
    queryKey: ['physician', 'mobile-queue', physicianId ?? 'all'],
    queryFn: () =>
      listCases({
        status: 'physician_review',
        page: 1,
        pageSize: 50,
        ...(physicianId ? { assignedPhysicianId: physicianId } : {}),
      }),
    enabled: meSettled,
  });

  const rows = queueQuery.data?.data ?? [];
  const greeting = timeOfDayGreeting();
  const lastName = formatPhysicianLastName(meQuery.data?.data.fullName);
  const waiting = rows.length;

  return (
    <AppShell>
      <div className="mx-auto max-w-xl">
        <section className="mb-5 rounded-2xl border border-aegis bg-navyDeep px-5 py-5 shadow-aegis-card">
          <p className="text-[11px] font-medium uppercase tracking-[0.25em] text-brassSoft">Aegis</p>
          <h1 className="mt-1 text-xl font-semibold text-white">
            {lastName ? `${greeting}, Dr. ${lastName}` : greeting}
          </h1>
          <p className="mt-1 text-sm text-white/75">
            {queueQuery.isLoading
              ? 'Loading your queue…'
              : waiting === 0
                ? 'No letters waiting for you.'
                : `${waiting} ${waiting === 1 ? 'letter is' : 'letters are'} waiting for you.`}
          </p>
        </section>

        {queueQuery.isLoading ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <Spinner label="Loading queue" />
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <EmptyState title="Queue is clear" message="No cases are waiting for your review." />
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/p/m/review/${encodeURIComponent(c.id)}`}
                  aria-label={`Review ${c.claimedCondition} for ${formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, c.veteranId)}`}
                  className="flex min-h-[72px] items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm active:bg-mistSoft"
                >
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-slate-900">{c.claimedCondition}</p>
                    <p className="mt-0.5 truncate text-sm text-slate-600">
                      {formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, c.veteranId)}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {c.id} · updated {formatRelativeTime(c.updatedAt)}
                    </p>
                  </div>
                  <span aria-hidden className="shrink-0 text-2xl leading-none text-slate-300">›</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-center text-xs text-slate-400">
          On a computer? The{' '}
          <Link to="/p/queue" className="underline">
            full physician console
          </Link>{' '}
          has editing and more.
        </p>
      </div>
    </AppShell>
  );
}
