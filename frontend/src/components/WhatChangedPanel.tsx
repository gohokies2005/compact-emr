import { type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLetterChangesSinceSigned, type LetterDiffSegment } from '../api/cases';

/**
 * "What changed since the physician last signed" (Ryan 2026-07-03). Shown at sign-off so a physician
 * re-signing an RN-corrected letter can GLANCE at the change instead of re-reading the whole letter.
 * Deterministic sentence-level diff (GET /cases/:id/letter/changes-since-signed) — additions green, removals
 * struck red, unchanged runs collapsed. Renders NOTHING when there's no prior signature or nothing changed
 * (fail-open: the endpoint returns { available:false } and this panel simply doesn't appear).
 */

function renderSegments(segments: readonly LetterDiffSegment[]): ReactElement[] {
  const out: ReactElement[] = [];
  let i = 0;
  let key = 0;
  while (i < segments.length) {
    const seg = segments[i]!;
    if (seg.kind === 'unchanged') {
      let j = i;
      while (j < segments.length && segments[j]!.kind === 'unchanged') j++;
      const run = segments.slice(i, j);
      if (run.length <= 1) {
        out.push(
          <p key={key++} className="text-slate-400">
            {run.map((s) => s.text).join(' ')}
          </p>,
        );
      } else {
        out.push(
          <p key={key++} className="italic text-slate-300">
            {`… ${run.length} unchanged sentences …`}
          </p>,
        );
      }
      i = j;
    } else if (seg.kind === 'added') {
      out.push(
        <p key={key++} className="rounded bg-emerald-100 px-1 text-emerald-900">
          <span className="mr-1 font-bold">+</span>
          {seg.text}
        </p>,
      );
      i++;
    } else {
      out.push(
        <p key={key++} className="rounded bg-rose-100 px-1 text-rose-800 line-through">
          <span className="mr-1 font-bold no-underline">{'−'}</span>
          {seg.text}
        </p>,
      );
      i++;
    }
  }
  return out;
}

export function WhatChangedPanel({ caseId, open }: { readonly caseId: string; readonly open: boolean }): ReactElement | null {
  const q = useQuery({
    queryKey: ['case', caseId, 'changes-since-signed'],
    queryFn: () => getLetterChangesSinceSigned(caseId),
    enabled: open,
    staleTime: 0,
  });

  const d = q.data?.data;
  if (d === undefined || !d.available || d.changed !== true || d.segments === undefined || d.segments.length === 0) {
    return null;
  }

  const when = d.signedAt !== undefined ? new Date(d.signedAt).toLocaleDateString() : null;
  const versionLabel = d.signedVersion !== undefined ? ` (v${d.signedVersion}${when !== null ? ` · ${when}` : ''})` : '';

  return (
    <div className="rounded-lg border border-sky-300 border-l-4 border-l-sky-500 bg-sky-50 p-4 text-sm" data-testid="what-changed-panel">
      <p className="font-semibold text-sky-900">What changed since you last signed{versionLabel}</p>
      <p className="mt-1 text-xs text-sky-800">
        {d.addedCount ?? 0} added, {d.removedCount ?? 0} removed. Review the highlighted changes below, then sign off.
      </p>
      <div className="mt-3 max-h-64 space-y-1 overflow-y-auto rounded border border-sky-200 bg-white p-3">
        {renderSegments(d.segments)}
      </div>
    </div>
  );
}
