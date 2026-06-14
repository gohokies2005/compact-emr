import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { presignDocument, recordDocument, uploadToPresignedUrl } from '../api/veterans';
import { reprocessCase } from '../api/cases';
import { getChartReadiness } from '../api/chart-readiness';
import { ACCEPT_ATTR, classifyEntry, isZip, uploadErrorReason, type CandidateResult } from '../routes/veterans/documentUpload';
import type { Case } from '../types/prisma';

// Shared document-upload core (Keystone Package 3, 2026-06-11). Extracted VERBATIM from the veteran
// chart's DocumentsPanel (uploadOne / expandSelection / onFiles + the selects/input/status line) so
// the case page can upload with the caseId PRE-PINNED while the chart keeps its case dropdown — one
// copy of the presign → S3 PUT → record flow, zip expansion, 50 MB cap, and per-file error surfacing.
//
// Two variants, chosen by props:
//   - pinned:   pass `caseId`  → NO case selector; every file lands on that claim (case page).
//   - dropdown: pass `cases`   → the claim <select> renders, defaulting to the first case (chart).
// Upload failures are NEVER silent: each file's real reason (API message / 403 / CORS) lands in the
// status line via uploadErrorReason — same NO-SILENT-ERRORS contract the chart shipped with.

const DOC_TAGS = ['STR', 'DBQ', 'C&P', 'Lay Statement', 'Other'];

interface UploadItem { readonly filename: string; readonly contentType: string; readonly sizeBytes: number; readonly blob: Blob; }

export function DocumentUploadPanel({ veteranId, caseId, cases = [], onUploaded }: {
  readonly veteranId: string;
  readonly caseId?: string; // pinned claim — when set, no case selector renders
  readonly cases?: readonly Case[]; // dropdown variant's claim list (ignored when caseId is set)
  readonly onUploaded: () => Promise<void> | void;
}) {
  const [selectedCaseId, setSelectedCaseId] = useState(cases[0]?.id ?? '');
  const [docTag, setDocTag] = useState('Other');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  // Reprocess is a real Anthropic SPEND (re-reads the whole record) — guard it behind a confirm so
  // nobody clicks it out of habit and runs up a bill (Ryan 2026-06-13). `watchReprocess` turns on a
  // live readiness poll AFTER a reprocess fires, so the panel can show a "done" notice when it finishes.
  const [confirming, setConfirming] = useState(false);
  const [watchReprocess, setWatchReprocess] = useState(false);
  const targetCaseId = caseId ?? selectedCaseId;

  // Live extraction status after a reprocess (shared queryKey with SendToDrafterPanel, so its draft
  // button grays/un-grays in lockstep). Only polls while a reprocess is being watched AND still building.
  const reprocessReadiness = useQuery({
    queryKey: ['case', targetCaseId, 'chart-readiness'],
    queryFn: () => getChartReadiness(targetCaseId),
    enabled: watchReprocess && targetCaseId.length > 0,
    refetchInterval: (q) => {
      const st = q.state.data?.data?.extractionState;
      return st === 'extracting' || st === 'ocr_in_progress' ? 8000 : false;
    },
  });

  // Upload one already-classified item via the existing presign -> upload -> record flow.
  // Throws on failure so the batch driver can record a per-file error without aborting the batch.
  async function uploadOne(item: UploadItem) {
    const presigned = await presignDocument(veteranId, { caseId: targetCaseId, filename: item.filename, contentType: item.contentType, sizeBytes: item.sizeBytes });
    await uploadToPresignedUrl(presigned.data.uploadUrl, new File([item.blob], item.filename, { type: item.contentType }), presigned.data.requiredHeaders);
    await recordDocument(veteranId, { caseId: targetCaseId, filename: item.filename, contentType: item.contentType, sizeBytes: item.sizeBytes, s3Key: presigned.data.s3Key, docTag });
  }

  // Expand the user's selection into upload candidates: zips are unpacked client-side, plain
  // files pass through. Returns { items, skipped } where skipped carries the reason per file.
  async function expandSelection(files: readonly File[]): Promise<{ items: UploadItem[]; skipped: { name: string; reason: string }[] }> {
    const items: UploadItem[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const reasonText: Record<string, string> = { directory_or_junk: 'skipped (folder/system file)', unsupported_type: 'unsupported type', too_large: 'over 50 MB' };
    const note = (r: CandidateResult & { ok: false }) => skipped.push({ name: r.path.split('/').pop() ?? r.path, reason: reasonText[r.reason] ?? 'skipped' });

    for (const file of files) {
      if (isZip(file)) {
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(file);
        const entries = Object.values(zip.files);
        for (const entry of entries) {
          const metaSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
          const cls = classifyEntry({ path: entry.name, sizeBytes: metaSize, isDir: entry.dir });
          if (!cls.ok) { note(cls); continue; }
          // Realize the blob, then re-check size against the true byte length (zip metadata can be
          // missing/zero in some JSZip builds).
          const blob = await entry.async('blob');
          const recheck = classifyEntry({ path: entry.name, sizeBytes: blob.size, isDir: entry.dir });
          if (!recheck.ok) { note(recheck); continue; }
          items.push({ filename: recheck.candidate.path, contentType: recheck.candidate.contentType, sizeBytes: blob.size, blob });
        }
      } else {
        const cls = classifyEntry({ path: file.name, sizeBytes: file.size, explicitType: file.type });
        if (!cls.ok) { note(cls); continue; }
        items.push({ filename: cls.candidate.path, contentType: cls.candidate.contentType, sizeBytes: file.size, blob: file });
      }
    }
    return { items, skipped };
  }

  // Keystone 4b — case-level reprocess: re-OCR every doc on the claim that lacks a terminal read
  // status + force a chart re-extract (salted triggerHash). Lives here so the SAME button surfaces
  // in BOTH Documents tabs (the chart's dropdown variant and the case page's pinned variant).
  // Errors are NEVER silent — the real reason lands in the status line (standing rule).
  async function onReprocess() {
    if (!targetCaseId) { setStatus('Create or select a case before reprocessing.'); return; }
    setBusy(true);
    try {
      setStatus('Reprocessing documents…');
      const { data } = await reprocessCase(targetCaseId);
      // Plain-language message. The old "re-OCR queued for 0 files" read like nothing happened — but 0
      // re-OCR just means every file already read fine; the chart RE-EXTRACT is the part that matters
      // (it re-reads the full record, e.g. to pick up a rating % an earlier windowed pass missed).
      let msg: string;
      if (data.extractEnqueued) {
        msg = data.reocrQueued === 0
          ? 'All files already read OK — a fresh full chart re-extraction is now running (~5–10 min). SC Conditions update when it finishes.'
          : `Re-OCR started for ${data.reocrQueued} file${data.reocrQueued === 1 ? '' : 's'} and a full chart re-extraction is now running (~5–10 min).`;
        setWatchReprocess(true); // turn on the live "done" poll
      } else if (data.extractReason === 'ocr_in_progress') {
        msg = 'Re-OCR started — the chart re-extraction will run automatically when OCR finishes.';
        setWatchReprocess(true);
      } else {
        msg = `Chart re-extract did not start (${data.extractReason ?? 'unknown'}).`;
      }
      if (data.reocrFailed && data.reocrFailed.length > 0) {
        msg += ` ${data.reocrFailed.length} re-OCR failed — ${data.reocrFailed.map((f) => `${f.documentId}: ${f.reason}`).join('; ')}.`;
      }
      setStatus(msg);
      await onUploaded();
    } catch (err) {
      setStatus(`Reprocess failed: ${uploadErrorReason(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Batch driver: validate the case, expand the selection, then upload sequentially with progress.
  async function onFiles(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    if (!targetCaseId) { setStatus('Create or select a case before uploading.'); return; }
    setBusy(true);
    try {
      setStatus('Reading selection…');
      const { items, skipped } = await expandSelection(files);
      if (items.length === 0) { setStatus(`Nothing to upload — ${skipped.length} skipped (unsupported/too large).`); return; }
      let uploaded = 0; const failed: { name: string; reason: string }[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (!item) continue;
        setStatus(`Uploading ${i + 1} of ${items.length}… (${item.filename})`);
        try { await uploadOne(item); uploaded += 1; }
        catch (err) { failed.push({ name: item.filename, reason: uploadErrorReason(err) }); }
      }
      const parts = [`${uploaded} uploaded`];
      if (skipped.length > 0) parts.push(`${skipped.length} skipped (unsupported/too large)`);
      // Surface the actual per-file failure reason — an upload that fails silently is the same
      // as "I uploaded but see nothing." Show the real cause so the RN can act on it.
      if (failed.length > 0) parts.push(`${failed.length} failed — ${failed.map((f) => `${f.name}: ${f.reason}`).join('; ')}`);
      setStatus(parts.join(', ') + '.');
      await onUploaded();
    } catch (err) {
      setStatus(`Upload failed: ${err instanceof Error ? err.message : 'unexpected error'}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="text-sm text-slate-500">Upload one or more files, or a .zip — PDF, JPG, PNG, DOC, DOCX, TXT (max 50 MB each).</p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        {caseId === undefined ? (
          <select aria-label="Assign to claim" className="input" value={selectedCaseId} onChange={(e) => setSelectedCaseId(e.target.value)}>
            {cases.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.claimedCondition}</option>)}
          </select>
        ) : null}
        <select aria-label="Document tag" className="input" value={docTag} onChange={(e) => setDocTag(e.target.value)}>{DOC_TAGS.map((t) => <option key={t}>{t}</option>)}</select>
        <input aria-label="Upload documents" className="text-sm" type="file" multiple accept={ACCEPT_ATTR} disabled={busy} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
        {/* Reprocess is behind a confirm step + a time/cost note so it isn't clicked out of habit — it
            re-reads the WHOLE record (real Anthropic spend, ~5–10 min). Kept always available (not hidden
            on "no file changes") because re-extracting unchanged files is exactly the Dorsey case: the
            files were fine, the earlier windowed extraction missed a rating %. (Ryan 2026-06-13.) */}
        {!confirming ? (
          <button
            type="button"
            className="self-start rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            title="Re-OCR any stuck files on this claim and re-run the full chart extraction (~5–10 min, uses API time)"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Reprocess documents
          </button>
        ) : (
          <div className="flex flex-col gap-1.5 self-start rounded-md border border-amber-300 bg-amber-50 p-2">
            <span className="text-xs text-amber-800">
              This re-reads the <strong>entire</strong> record and re-runs extraction — <strong>~5–10 min</strong> and uses API time.
              Only needed if files changed or a detail was missed. Continue?
            </span>
            <div className="flex gap-2">
              <button type="button" className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50" disabled={busy} onClick={() => { setConfirming(false); void onReprocess(); }}>
                Confirm reprocess
              </button>
              <button type="button" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {status ? <p className="mt-2 text-sm text-slate-500">{status}</p> : null}
      {/* Live "where is it" + completion notice after a reprocess — shares the readiness query with the
          draft panel, so this flips to "Done" the moment extraction settles, no refresh needed. */}
      {watchReprocess ? (() => {
        const st = reprocessReadiness.data?.data?.extractionState;
        const g = reprocessReadiness.data?.data?.extractionGaps ?? null;
        const gapped = g != null && (g.uncoveredPages > 0 || g.truncatedWindows > 0);
        if (st === 'extracting' || st === 'ocr_in_progress') {
          return <p className="mt-2 text-sm text-sky-700">⏳ Re-extracting the chart… (~5–10 min). You can leave this page — it keeps running.</p>;
        }
        if (st === 'chart_ready') {
          return <p className="mt-2 text-sm font-medium text-emerald-700">✅ Done — the chart was re-extracted and is ready to draft.{gapped ? ' (Some pages went unread — reprocess again only if a key detail might be on a missing page.)' : ''}</p>;
        }
        if (st === 'extract_failed') {
          return <p className="mt-2 text-sm font-medium text-rose-700">⚠️ Extraction failed. Click Reprocess to try again, or override on the draft panel.</p>;
        }
        return null;
      })() : null}
    </>
  );
}
