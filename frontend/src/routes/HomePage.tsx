import { Navigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/useAuth';
import { AppShell } from '../layout/AppShell';
import { Card } from '../components/ui/Card';
import { BridgeRotation } from '../components/BridgeRotation';
import { Spinner } from '../components/ui/Spinner';
import {
  listCases,
  listFilesPendingManualGlobal,
  listKeyDocsNeedingReview,
} from '../api/cases';
import { listVeterans } from '../api/veterans';
import { getMe } from '../api/users';
import { timeOfDayGreeting } from '../lib/greeting';
import { formatFirstName } from '../lib/format';
import type { CaseStatus } from '../types/prisma';

type Tone = 'default' | 'amber';

function DashboardCard({
  title,
  value,
  description,
  to,
  tone = 'default',
  loading = false,
}: {
  readonly title: string;
  readonly value: string | number;
  readonly description: string;
  readonly to: string;
  readonly tone?: Tone;
  readonly loading?: boolean;
}) {
  const toneClass =
    tone === 'amber'
      ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
      : 'border-slate-200 bg-white hover:border-slate-300';
  return (
    <Link to={to} className="block">
      <Card className={`transition ${toneClass}`}>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</p>
        <p className="mt-2 text-3xl font-semibold text-slate-900">
          {loading ? <Spinner /> : value}
        </p>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      </Card>
    </Link>
  );
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function useStatusTotal(status: CaseStatus) {
  return useQuery({
    queryKey: ['cases', 'count', status],
    queryFn: () => listCases({ status, page: 1, pageSize: 1 }),
  });
}

export function HomePage() {
  const { role } = useAuth();

  const recentCasesQuery = useQuery({
    queryKey: ['cases', 'recent'],
    queryFn: () => listCases({ page: 1, pageSize: 100 }),
  });

  const recordsCount = useStatusTotal('records');
  const viabilityCount = useStatusTotal('viability');
  const draftingCount = useStatusTotal('drafting');
  const physicianReviewCount = useStatusTotal('physician_review');

  const manualSummaryQuery = useQuery({
    queryKey: ['rn', 'files-pending-manual', 'count'],
    queryFn: () => listFilesPendingManualGlobal(1),
  });
  const keyDocsQuery = useQuery({
    queryKey: ['rn', 'key-docs-needing-review', 'count'],
    queryFn: () => listKeyDocsNeedingReview(1),
  });

  const veteransQuery = useQuery({
    queryKey: ['veterans', 'all'],
    queryFn: () => listVeterans(''),
  });

  // Personalized hero greeting (P4): first name from /users/me. retry:false — a 404 (no AppUser
  // row) just falls back to the plain greeting, never blocks the dashboard.
  const meQuery = useQuery({ queryKey: ['users', 'me'], queryFn: getMe, retry: false, staleTime: 60_000 });

  // Physician redirect must come after hooks so hook order stays stable.
  if (role === 'physician') return <Navigate to="/p/queue" replace />;

  const casesUpdatedToday =
    recentCasesQuery.data?.data.filter((c) => isToday(c.updatedAt)).length ?? 0;

  const rnQueueTotal =
    (manualSummaryQuery.data?.total ?? 0) + (keyDocsQuery.data?.total ?? 0);

  const preDraftTotal =
    (recordsCount.data?.total ?? 0) +
    (viabilityCount.data?.total ?? 0) +
    (draftingCount.data?.total ?? 0);

  const physicianReviewTotal = physicianReviewCount.data?.total ?? 0;
  const veteransTotal = veteransQuery.data?.data.length ?? 0;
  const greeting = timeOfDayGreeting();
  const firstName = formatFirstName(meQuery.data?.data.name);

  return (
    <AppShell>
      {/* Ambient maritime hero — the bridge rotation lives here (caption suppressed; this is backdrop, not a
          photo to study). Dashboard chrome only — never behind a clinical chart. */}
      <section className="relative mb-8 overflow-hidden rounded-2xl border border-aegis shadow-aegis-card">
        <BridgeRotation caption={false} className="h-40 sm:h-48">
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-navyDeep/85 via-navyDeep/50 to-transparent" />
          <div className="relative flex h-full flex-col justify-center px-7">
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-brassSoft">Aegis</p>
            <h1 className="mt-1 text-2xl font-semibold text-white sm:text-3xl">{firstName ? `${greeting}, ${firstName}` : greeting}</h1>
            <p className="mt-1 text-sm text-white/75">Daily workflow at a glance.</p>
          </div>
        </BridgeRotation>
      </section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <DashboardCard
          title="Today's work"
          value={casesUpdatedToday}
          description="Cases updated today"
          to="/cases"
          loading={recentCasesQuery.isLoading}
        />
        <DashboardCard
          title="RN queue"
          value={rnQueueTotal}
          description="Files + key docs needing RN review"
          to="/rn"
          tone={rnQueueTotal > 0 ? 'amber' : 'default'}
          loading={manualSummaryQuery.isLoading || keyDocsQuery.isLoading}
        />
        <DashboardCard
          title="Pre-draft cases"
          value={preDraftTotal}
          description="Records, viability and drafting"
          to="/cases"
          loading={recordsCount.isLoading || viabilityCount.isLoading || draftingCount.isLoading}
        />
        <DashboardCard
          title="Physician review"
          value={physicianReviewTotal}
          description="Awaiting physician sign-off"
          to="/cases?status=physician_review"
          loading={physicianReviewCount.isLoading}
        />
        <DashboardCard
          title="Veterans"
          value={veteransTotal}
          description="Veterans on file"
          to="/veterans"
          loading={veteransQuery.isLoading}
        />
        <DashboardCard
          title="Case list"
          value="All"
          description="Browse every case"
          to="/cases"
        />
      </div>

      <div className="mt-8">
        <Card>
          <h2 className="text-base font-semibold text-slate-900">RN workflow</h2>
          <p className="mt-1 text-sm text-slate-500">The standard path for each new claim.</p>
          <ol className="mt-4 space-y-2 text-sm">
            <li>
              <Link className="text-indigo-600 hover:underline" to="/veterans">
                1. Open or create the veteran chart
              </Link>
            </li>
            <li>
              <Link className="text-indigo-600 hover:underline" to="/rn">
                2. Complete RN file review
              </Link>
            </li>
            <li>
              <Link className="text-indigo-600 hover:underline" to="/cases">
                3. Send the case to the drafter
              </Link>
            </li>
          </ol>
        </Card>
      </div>
    </AppShell>
  );
}
