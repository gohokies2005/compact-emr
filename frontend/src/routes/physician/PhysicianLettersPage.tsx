import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AppShell } from '../../layout/AppShell';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { EmptyState } from '../../components/ui/EmptyState';
import { CaseStatusBadge } from '../../components/ui/CaseStatusBadge';
import { BridgeRotation } from '../../components/BridgeRotation';
import { listCases, type CaseLite } from '../../api/cases';
import { formatRelativeTime } from '../../lib/date';
import { formatNameLastFirst } from '../../lib/format';

export function PhysicianLettersPage() {
  const deliveredQuery = useQuery({
    queryKey: ['physician', 'letters', 'delivered'],
    queryFn: () => listCases({ status: 'delivered', page: 1, pageSize: 50 }),
  });
  const paidQuery = useQuery({
    queryKey: ['physician', 'letters', 'paid'],
    queryFn: () => listCases({ status: 'paid', page: 1, pageSize: 50 }),
  });

  const loading = deliveredQuery.isLoading || paidQuery.isLoading;
  const rows: readonly CaseLite[] = [
    ...(deliveredQuery.data?.data ?? []),
    ...(paidQuery.data?.data ?? []),
  ];

  return (
    <AppShell>
      {/* Same ambient bridge band as the Queue — every MAIN physician tab carries it; it never
          mounts inside a claim/letter view (Ryan 2026-06-10 P2.3). Wrapper mirrors PhysicianQueuePage. */}
      <section className="relative mb-8 overflow-hidden rounded-2xl border border-aegis shadow-aegis-card">
        <BridgeRotation caption={false} className="h-40 sm:h-48">
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-navyDeep/85 via-navyDeep/50 to-transparent" />
          <div className="relative flex h-full flex-col justify-center px-7">
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-brassSoft">Aegis</p>
            <h1 className="mt-1 text-2xl font-semibold text-white sm:text-3xl">My letters</h1>
            <p className="mt-1 text-sm text-white/75">Delivered and paid letters</p>
          </div>
        </BridgeRotation>
      </section>

      <Card className="p-0">
        {loading ? (
          <div className="p-6">
            <Spinner label="Loading letters" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No letters yet" message="Delivered and paid letters will appear here." />
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
                {rows.map((c) => (
                  <tr key={c.id}>
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
                      <Link className="text-indigo-600 hover:underline" to={`/p/review/${encodeURIComponent(c.id)}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
