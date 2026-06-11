import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { CaseStatusBadge } from '../../components/ui/CaseStatusBadge';
import { BridgeRotation } from '../../components/BridgeRotation';
import { listCases } from '../../api/cases';
import { getPhysicianMe } from '../../api/physicians';
import { formatRelativeTime } from '../../lib/date';
import { formatNameLastFirst, formatPhysicianLastName } from '../../lib/format';
import { timeOfDayGreeting } from '../../lib/greeting';

export function PhysicianQueuePage() {
  const navigate = useNavigate();
  const queueQuery = useQuery({
    queryKey: ['physician', 'queue'],
    queryFn: () => listCases({ status: 'physician_review', page: 1, pageSize: 50 }),
  });
  // Personalized hero (P4): "Good <tod>, Dr. <LastName>" from the caller's own Physician row.
  // retry:false — a 404 (no Physician mapping) falls back to the plain greeting, never blocks.
  const physicianMeQuery = useQuery({ queryKey: ['physicians', 'me'], queryFn: getPhysicianMe, retry: false, staleTime: 60_000 });

  const rows = queueQuery.data?.data ?? [];
  const greeting = timeOfDayGreeting();
  const lastName = formatPhysicianLastName(physicianMeQuery.data?.data.fullName);

  return (
    <AppShell>
      {/* Ambient maritime hero — same calm bridge band the dashboard carries, to steady the
          doctor's working surface. Queue chrome only; never behind a letter editor or chart. */}
      <section className="relative mb-8 overflow-hidden rounded-2xl border border-aegis shadow-aegis-card">
        <BridgeRotation caption={false} className="h-40 sm:h-48">
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-navyDeep/85 via-navyDeep/50 to-transparent" />
          <div className="relative flex h-full flex-col justify-center px-7">
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-brassSoft">Aegis</p>
            <h1 className="mt-1 text-2xl font-semibold text-white sm:text-3xl">{lastName ? `${greeting}, Dr. ${lastName}` : greeting}</h1>
            <p className="mt-1 text-sm text-white/75">Physician queue — letters awaiting your review</p>
          </div>
        </BridgeRotation>
      </section>

      <Card className="p-0">
        {queueQuery.isLoading ? (
          <div className="p-6">
            <Spinner label="Loading queue" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <EmptyState title="Queue is clear" message="No cases are waiting for physician review." />
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Case</th>
                  <th className="px-4 py-2">Veteran</th>
                  <th className="px-4 py-2">Condition</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Updated</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => {
                  const reviewHref = `/p/review/${encodeURIComponent(c.id)}`;
                  return (
                    <tr
                      key={c.id}
                      role="link"
                      tabIndex={0}
                      aria-label={`Review case ${c.id}`}
                      onClick={() => navigate(reviewHref)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate(reviewHref);
                        }
                      }}
                      className="cursor-pointer hover:bg-mistSoft focus:bg-mistSoft focus:outline-none"
                    >
                      <td className="px-4 py-2 font-medium text-slate-900">{c.id}</td>
                      <td className="px-4 py-2 text-slate-700">
                        {formatNameLastFirst(c.veteran?.firstName, c.veteran?.lastName, c.veteranId)}
                      </td>
                      <td className="px-4 py-2 text-slate-700">{c.claimedCondition}</td>
                      <td className="px-4 py-2">
                        <CaseStatusBadge status={c.status} />
                      </td>
                      <td className="px-4 py-2 text-slate-500">{formatRelativeTime(c.updatedAt)}</td>
                      <td className="px-4 py-2 text-right">
                        <Link
                          className="text-indigo-600 hover:underline"
                          to={reviewHref}
                          onClick={(e) => e.stopPropagation()}
                        >
                          Review
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
