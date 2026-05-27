import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '../layout/AppShell';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { getCostReport, fetchCostCsv } from '../api/reports';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function CostsPage() {
  const defaults = useMemo(() => ({ from: isoDaysAgo(90), to: isoDaysAgo(0) }), []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  // Committed range drives the query; the inputs are local until the user hits Apply so we
  // don't refetch on every keystroke.
  const [range, setRange] = useState<{ from: string; to: string }>(defaults);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const report = useQuery({
    queryKey: ['cost-report', range.from, range.to],
    queryFn: () => getCostReport(range.from, range.to),
  });

  const rows = report.data?.rows ?? [];
  const total = report.data?.totalCostUsd ?? 0;

  async function onExport() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await fetchCostCsv(range.from, range.to);
    } catch {
      setDownloadError('Could not download the CSV. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  return <AppShell><div className="space-y-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Drafting costs</h1>
        <p className="text-sm text-slate-500">Per-claim drafting (API) cost, grouped by case over the selected window.</p>
      </div>
    </div>

    <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
      <label className="block text-sm lg:w-48"><span className="mb-1 block font-medium text-slate-700">From</span>
        <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
      </label>
      <label className="block text-sm lg:w-48"><span className="mb-1 block font-medium text-slate-700">To</span>
        <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
      </label>
      <Button variant="secondary" onClick={() => setRange({ from, to })}>Apply</Button>
      <Button variant="primary" onClick={onExport} loading={downloading} disabled={rows.length === 0}>Export CSV</Button>
    </div>
    {downloadError ? <p className="text-sm text-rose-600">{downloadError}</p> : null}

    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
          <th className="px-4 py-3">Case</th>
          <th className="px-4 py-3">Veteran</th>
          <th className="px-4 py-3">Condition</th>
          <th className="px-4 py-3">Status</th>
          <th className="px-4 py-3 text-right">Draft runs</th>
          <th className="px-4 py-3 text-right">Cost</th>
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => <tr key={r.caseId} className="hover:bg-slate-50">
            <td className="px-4 py-3 font-medium text-slate-700">{r.caseId}</td>
            <td className="px-4 py-3 text-slate-600">{r.veteranName || '—'}</td>
            <td className="px-4 py-3 text-slate-700">{r.claimedCondition}</td>
            <td className="px-4 py-3 text-slate-600">{r.status}</td>
            <td className="px-4 py-3 text-right text-slate-600">{r.draftCount}</td>
            <td className="px-4 py-3 text-right font-medium text-slate-800">{formatUsd(r.costUsd)}</td>
          </tr>)}
        </tbody>
        {rows.length > 0 ? <tfoot className="border-t border-slate-200 bg-slate-50 text-sm font-semibold text-slate-900"><tr>
          <td className="px-4 py-3" colSpan={5}>Total</td>
          <td className="px-4 py-3 text-right">{formatUsd(total)}</td>
        </tr></tfoot> : null}
      </table>
      {report.isLoading ? <div className="p-6 text-sm text-slate-500"><Spinner label="Loading costs…" /></div> : null}
      {!report.isLoading && report.isError ? <div className="p-6"><EmptyState title="Could not load costs" message="The cost report failed to load. Adjust the dates and try Apply again." /></div> : null}
      {!report.isLoading && !report.isError && rows.length === 0 ? <div className="p-6"><EmptyState title="No cases in range" message="No cases were created in the selected date window." /></div> : null}
    </div>
  </div></AppShell>;
}
