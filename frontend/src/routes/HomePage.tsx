import { Navigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/useAuth';
import { AppShell } from '../layout/AppShell';
import { Card } from '../components/ui/Card';
import { BridgeRotation } from '../components/BridgeRotation';
import { Spinner } from '../components/ui/Spinner';
import { getDashboard, type DashboardTile, type DashboardTileFilter } from '../api/reports';
import { getMe } from '../api/users';
import { timeOfDayGreeting } from '../lib/greeting';
import { formatFirstName } from '../lib/format';

type Tone = 'default' | 'amber' | 'red';

const TONE_CLASS: Record<Tone, string> = {
  default: 'border-slate-200 bg-white hover:border-slate-300',
  amber: 'border-amber-300 bg-amber-50 hover:border-amber-400',
  red: 'border-rose-300 bg-rose-50 hover:border-rose-400',
};

const VALUE_TEXT: Record<Tone, string> = {
  default: 'text-slate-900',
  amber: 'text-amber-700',
  red: 'text-rose-700',
};

// === D2 dashboard tiles (2026-06-13) ===
// Translate a backend tile `filter` contract into the in-app deep-link that reproduces its count.
// The backend owns the count + the filter shape; the frontend owns only this mapping to a route.
//   - cases / status            → /cases?status=<s>
//   - cases / statuses[] (group)→ /cases?statuses=<csv>   (CasesPage seeds a multi-status filter)
//   - cases / status + unpaid…  → /cases?status=delivered (the closest reachable list; the >Nday
//                                  unpaid dimension isn't a Cases-list filter — the delivered list
//                                  is where the RN actions these)
//   - intakes / createdSince    → /intake                  (new-today; the pool has no date filter,
//                                  so we land on the default pool view)
//   - intakes / status + older… → /intake?status=<s>       (IntakePoolPage seeds its status)
//   - draft-jobs / stuck        → /cases?status=drafting    (no draft-jobs list page exists; a stuck
//                                  job's case sits in 'drafting' — the closest actionable surface)
//   - veterans                  → /veterans
// Returns null for the one non-clickable tile (the turnaround duration) or any unmapped filter.
function tileHref(filter: DashboardTileFilter | undefined): string | null {
  if (filter === undefined) return null;
  switch (filter.kind) {
    case 'cases':
      if ('statuses' in filter) return `/cases?statuses=${encodeURIComponent(filter.statuses.join(','))}`;
      return `/cases?status=${encodeURIComponent(filter.status)}`;
    case 'intakes':
      if ('status' in filter) return `/intake?status=${encodeURIComponent(filter.status)}`;
      return '/intake';
    case 'draft-jobs':
      return '/cases?status=drafting';
    case 'veterans':
      return '/veterans';
    default:
      return null;
  }
}

// Urgency coloring (plan §D2): the delinquent + stuck tiles turn RED when their count is > 0 — they
// represent SLA breaches the RN must clear. Every other clickable tile is calm/neutral.
const RED_WHEN_NONZERO = new Set(['delinquent_intakes', 'delinquent_payments', 'stuck_drafts']);

function toneForTile(tile: DashboardTile): Tone {
  if (RED_WHEN_NONZERO.has(tile.key) && (tile.count ?? 0) > 0) return 'red';
  return 'default';
}

function TileCard({ tile }: { readonly tile: DashboardTile }) {
  const tone = toneForTile(tile);
  const href = tile.clickable ? tileHref(tile.filter) : null;

  // The turnaround tile carries value+unit (a duration), not a count. null value → honest "—".
  const isDuration = tile.value !== undefined || tile.unit !== undefined;
  const display = isDuration
    ? tile.value === null || tile.value === undefined
      ? '—'
      : `${tile.value}${tile.unit ? ` ${tile.unit}` : ''}`
    : (tile.count ?? 0);

  const description = isDuration
    ? (tile.reason ?? 'Average over the last 7 days')
    : tile.key === 'delinquent_payments'
      ? 'Delivered, letter unpaid > 3 days'
      : tile.key === 'delinquent_intakes'
        ? 'Pending intakes older than 7 days'
        : tile.key === 'stuck_drafts'
          ? 'Drafts running too long'
          : '';

  const body = (
    <Card className={`transition ${TONE_CLASS[tone]}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{tile.label}</p>
      <p className={`mt-2 text-3xl font-semibold ${VALUE_TEXT[tone]}`}>{display}</p>
      {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
    </Card>
  );

  // Non-clickable (turnaround) or unmapped filter → render the card without a link.
  return href ? (
    <Link to={href} className="block">
      {body}
    </Link>
  ) : (
    <div>{body}</div>
  );
}

export function HomePage() {
  const { role } = useAuth();

  // Single source of truth for every tile's count + filter (backend owns the Pacific "today"
  // boundary + the display-group status sets). Replaces the old ~7 client-side listCases counts.
  const dashboardQuery = useQuery({ queryKey: ['dashboard'], queryFn: getDashboard });

  // Personalized hero greeting (P4): first name from /users/me. retry:false — a 404 (no AppUser
  // row) just falls back to the plain greeting, never blocks the dashboard.
  const meQuery = useQuery({ queryKey: ['users', 'me'], queryFn: getMe, retry: false, staleTime: 60_000 });

  // Physician redirect must come after hooks so hook order stays stable.
  if (role === 'physician') return <Navigate to="/p/queue" replace />;

  const greeting = timeOfDayGreeting();
  const firstName = formatFirstName(meQuery.data?.data.name);
  const tiles = dashboardQuery.data?.tiles ?? [];

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

      {dashboardQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading dashboard…</div>
      ) : dashboardQuery.isError ? (
        <Card className="border-rose-200 bg-rose-50">
          <p className="text-sm text-rose-700">The dashboard metrics couldn’t be loaded. Refresh to try again.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {tiles.map((tile) => <TileCard key={tile.key} tile={tile} />)}
        </div>
      )}

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
