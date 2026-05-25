import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { ConflictError } from '../api/client';
import {
  createClarification,
  listClarifications,
  resolveClarification,
  type Clarification,
  type ClarificationAudience,
  type ClarificationStatus,
} from '../api/cases';
import { formatRelativeTime } from '../lib/date';

type ClarificationFilter = 'all' | ClarificationStatus;

const FILTERS: readonly { readonly value: ClarificationFilter; readonly label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];

const AUDIENCE_OPTIONS: readonly {
  readonly value: ClarificationAudience;
  readonly label: string;
  readonly className: string;
}[] = [
  { value: 'physician', label: 'Physician', className: 'border-indigo-200 bg-indigo-50 text-indigo-700' },
  { value: 'ops_staff', label: 'Ops staff', className: 'border-slate-200 bg-slate-100 text-slate-700' },
  { value: 'veteran',   label: 'Veteran',   className: 'border-blue-200 bg-blue-50 text-blue-700' },
];

const STATUS_CLASSES: Record<ClarificationStatus, string> = {
  open: 'border-amber-200 bg-amber-50 text-amber-700',
  resolved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  dismissed: 'border-slate-200 bg-slate-100 text-slate-700',
};

interface ClarificationsPanelProps {
  readonly caseId: string;
}

function audienceLabel(audience: ClarificationAudience): string {
  return AUDIENCE_OPTIONS.find((o) => o.value === audience)?.label ?? audience;
}

function audienceClassName(audience: ClarificationAudience): string {
  return AUDIENCE_OPTIONS.find((o) => o.value === audience)?.className ?? 'border-slate-200 bg-slate-100 text-slate-700';
}

function statusLabel(status: ClarificationStatus): string {
  if (status === 'open') return 'Open';
  if (status === 'resolved') return 'Resolved';
  return 'Dismissed';
}

function shouldTruncateQuestion(question: string): boolean { return question.length > 220; }
function visibleQuestion(question: string, expanded: boolean): string {
  if (expanded || !shouldTruncateQuestion(question)) return question;
  return `${question.slice(0, 220).trimEnd()}...`;
}

function updateClarificationInList(
  current: { readonly data: readonly Clarification[] } | undefined,
  updated: Clarification,
): { readonly data: readonly Clarification[] } | undefined {
  if (!current) return current;
  return { data: current.data.map((item) => (item.id === updated.id ? updated : item)) };
}

export function ClarificationsPanel({ caseId }: ClarificationsPanelProps) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ClarificationFilter>('open');
  const [showForm, setShowForm] = useState(false);
  const [audience, setAudience] = useState<ClarificationAudience>('physician');
  const [question, setQuestion] = useState('');
  const [resolving, setResolving] = useState<Clarification | null>(null);
  const [resolutionStatus, setResolutionStatus] = useState<'resolved' | 'dismissed'>('resolved');
  const [resolution, setResolution] = useState('');
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const statusParam = filter === 'all' ? undefined : filter;

  const clarificationsQuery = useQuery({
    queryKey: ['case', caseId, 'clarifications', filter],
    queryFn: () => listClarifications(caseId, statusParam),
  });

  const clarifications = clarificationsQuery.data?.data ?? [];

  const createMutation = useMutation({
    mutationFn: () => createClarification(caseId, { audience, question: question.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['case', caseId, 'clarifications'] });
      setQuestion('');
      setAudience('physician');
      setShowForm(false);
      setErrorMessage(null);
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Clarification could not be created.';
      setErrorMessage(message);
    },
  });

  const resolveMutation = useMutation({
    mutationFn: () => {
      if (!resolving) throw new Error('No clarification selected.');
      return resolveClarification(resolving.id, {
        status: resolutionStatus,
        ...(resolution.trim().length > 0 && { resolution: resolution.trim() }),
      });
    },
    onSuccess: async (response) => {
      queryClient.setQueryData(['case', caseId, 'clarifications', filter], (current: unknown) =>
        updateClarificationInList(current as { readonly data: readonly Clarification[] } | undefined, response.data),
      );
      await queryClient.invalidateQueries({ queryKey: ['case', caseId, 'clarifications'] });
      setResolving(null);
      setResolution('');
      setResolutionStatus('resolved');
      setErrorMessage(null);
    },
    onError: async (error: unknown) => {
      await clarificationsQuery.refetch();
      const message = error instanceof ConflictError
        ? 'This clarification was already resolved.'
        : 'Clarification could not be updated.';
      setErrorMessage(message);
    },
  });

  const canSubmitQuestion = question.trim().length > 0 && question.trim().length <= 800;
  const visibleClarifications = useMemo(() => clarifications, [clarifications]);

  function toggleExpanded(id: string) {
    setExpandedIds((current) => current.includes(id) ? current.filter((c) => c !== id) : [...current, id]);
  }

  function openResolutionModal(clarification: Clarification, status: 'resolved' | 'dismissed') {
    setResolving(clarification);
    setResolutionStatus(status);
    setResolution('');
    setErrorMessage(null);
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-800">Clarifications</h2>
          <p className="mt-1 text-sm text-slate-500">Raise, track, and resolve case-specific clarification requests.</p>
        </div>
        <Button type="button" variant="primary" onClick={() => setShowForm((c) => !c)}>Raise clarification</Button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((option) => (
          <button key={option.value} type="button" onClick={() => setFilter(option.value)}
            className={`rounded-full border px-3 py-1 text-sm ${filter === option.value ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
            {option.label}
          </button>
        ))}
      </div>

      {showForm ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div>
            <div className="text-sm font-medium text-slate-800">Audience</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {AUDIENCE_OPTIONS.map((option) => (
                <button key={option.value} type="button" onClick={() => setAudience(option.value)}
                  className={`rounded-full border px-3 py-1 text-sm ${audience === option.value ? option.className : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {audience === 'veteran' ? (
            <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
              This will appear in the records request the veteran receives.
            </div>
          ) : null}

          <label className="mt-4 block">
            <span className="text-sm font-medium text-slate-800">Question</span>
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={4} maxLength={800}
              className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
              placeholder="What needs to be clarified before this case can move forward?" />
            <span className="mt-1 block text-xs text-slate-500">{question.length}/800</span>
          </label>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="secondary"
              onClick={() => { setShowForm(false); setQuestion(''); setErrorMessage(null); }}
              disabled={createMutation.isPending}>Cancel</Button>
            <Button type="button" variant="primary" loading={createMutation.isPending}
              disabled={!canSubmitQuestion || createMutation.isPending}
              onClick={() => createMutation.mutate()}>Submit</Button>
          </div>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{errorMessage}</div>
      ) : null}

      {clarificationsQuery.isLoading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading clarifications</div>
      ) : null}

      {!clarificationsQuery.isLoading && visibleClarifications.length === 0 ? (
        <div className="mt-6"><EmptyState title="No clarifications" message="No clarifications found for this filter." /></div>
      ) : null}

      {visibleClarifications.length > 0 ? (
        <div className="mt-6 space-y-3">
          {visibleClarifications.map((clarification) => {
            const expanded = expandedIds.includes(clarification.id);
            const isOpen = clarification.status === 'open';
            return (
              <article key={clarification.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${audienceClassName(clarification.audience)}`}>
                        {audienceLabel(clarification.audience)}
                      </span>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_CLASSES[clarification.status]}`}>
                        {statusLabel(clarification.status)}
                      </span>
                      <span className="text-xs text-slate-500">Raised {formatRelativeTime(clarification.createdAt)}</span>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm text-slate-800">{visibleQuestion(clarification.question, expanded)}</p>
                    {shouldTruncateQuestion(clarification.question) ? (
                      <button type="button" onClick={() => toggleExpanded(clarification.id)} className="mt-2 text-sm font-medium text-slate-600 hover:text-slate-900">
                        {expanded ? 'Show less' : 'Show more'}
                      </button>
                    ) : null}
                    {clarification.status !== 'open' ? (
                      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Resolution</div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{clarification.resolution?.trim() || 'No resolution note provided.'}</p>
                        {clarification.resolvedAt ? (
                          <p className="mt-2 text-xs text-slate-500">Closed {formatRelativeTime(clarification.resolvedAt)}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {isOpen ? (
                    <div className="flex shrink-0 gap-2">
                      <Button type="button" variant="secondary" onClick={() => openResolutionModal(clarification, 'resolved')}>Resolve</Button>
                      <Button type="button" variant="ghost" onClick={() => openResolutionModal(clarification, 'dismissed')}>Dismiss</Button>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {resolving ? (
        <div role="dialog" aria-modal="true" aria-labelledby="resolve-clarification-title">
          <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
          <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl">
            <h3 id="resolve-clarification-title" className="text-lg font-semibold text-slate-900">
              {resolutionStatus === 'resolved' ? 'Resolve clarification' : 'Dismiss clarification'}
            </h3>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{resolving.question}</p>
            <label className="mt-4 block">
              <span className="text-sm font-medium text-slate-800">Resolution note (optional)</span>
              <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={4} maxLength={800}
                className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
                placeholder="Optional resolution note." />
              <span className="mt-1 block text-xs text-slate-500">{resolution.length}/800</span>
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="secondary"
                onClick={() => { setResolving(null); setResolution(''); setResolutionStatus('resolved'); }}
                disabled={resolveMutation.isPending}>Cancel</Button>
              <Button type="button" variant={resolutionStatus === 'resolved' ? 'primary' : 'secondary'}
                loading={resolveMutation.isPending} disabled={resolveMutation.isPending}
                onClick={() => resolveMutation.mutate()}>
                {resolutionStatus === 'resolved' ? 'Confirm resolved' : 'Confirm dismissed'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
