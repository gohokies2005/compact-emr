import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { presignDocument, recordDocument, uploadToPresignedUrl, listDocuments } from '../api/veterans';
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
  const [confirming, setConfirming] = useState(false);
  // FIX (Ryan 2026-06-16): the "processing" note + the button-disable are derived from SERVER state
  // (chart-readiness.extractionState), NOT local React state — so navigating away and back (which
  // unmounts + remounts this panel) no longer loses the note, and a reprocess that's still running is
  // correctly shown + the button stays grayed. `justFiredRef` ONLY nudges the poll to start quickly
  // after a click (to catch the chart_ready→extracting flip in the same mount); it is not load-bearing
  // for correctness — on remount the server state already reflects the in-flight run.
  const justFiredRef = useRef(0);
  const [, forcePoll] = useState(0); // bump to re-evaluate refetchInterval right after a click
  const targetCaseId = caseId ?? selectedCaseId;

  // Reprocess document-picker (Ryan 2026-06-16): the Reprocess button opens a modal listing every chart
  // file. All selected by DEFAULT (re-read the whole record); deselect-all/select-all toggle + per-file
  // checkboxes so a single just-uploaded file can be re-read alone (saves time + tokens). Selected docs
  // are FORCE re-read — the backend clears their pages so even an already-'read' doc re-runs through the
  // (now vision) pipeline. Covers Jotform-ingested AND manually-uploaded docs alike (all are Documents).
  const docPicker = useQuery({
    queryKey: ['veteran', veteranId, 'documents'],
    queryFn: () => listDocuments(veteranId),
    enabled: confirming && veteranId.length > 0,
  });
  const caseDocs = (docPicker.data?.data ?? []).filter(
    (d) => d.caseId === targetCaseId && !d.s3Key.endsWith('00000000-screening-summary.txt'),
  );
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [pickerInit, setPickerInit] = useState(false);
  // Default to ALL selected once the list loads for this opening; reset when the modal closes.
  useEffect(() => {
    if (confirming && !pickerInit && caseDocs.length > 0) {
      setSelectedDocIds(new Set(caseDocs.map((d) => d.id)));
      setPickerInit(true);
    }
    if (!confirming && pickerInit) setPickerInit(false);
  }, [confirming, caseDocs, pickerInit]);
  const allSelected = caseDocs.length > 0 && selectedDocIds.size >= caseDocs.length;
  function toggleDoc(id: string) {
    setSelectedDocIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleAll() {
    setSelectedDocIds(allSelected ? new Set() : new Set(caseDocs.map((d) => d.id)));
  }

  // Live extraction state from the SERVER (shared queryKey with SendToDrafterPanel, so the draft button
  // grays in lockstep). ALWAYS enabled when there's a case + refetchOnMount → on a remount during an
  // in-flight run it immediately reflects "still processing" (the navigate-away-and-back fix). Polls
  // while a run is active, and briefly after a reprocess click to catch the chart_ready→extracting flip.
  const readiness = useQuery({
    queryKey: ['case', targetCaseId, 'chart-readiness'],
    queryFn: () => getChartReadiness(targetCaseId),
    enabled: targetCaseId.length > 0,
    refetchOnMount: true,
    refetchInterval: (q) => {
      const st = q.state.data?.data?.extractionState;
      if (st === 'extracting' || st === 'ocr_in_progress') return 8000; // actively processing → poll
      if (Date.now() - justFiredRef.current < 60_000) return 5000; // just clicked → catch the flip
      return false; // idle → stop polling
    },
  });
  const extractionState = readiness.data?.data?.extractionState;
  // SERVER-derived → survives unmount/remount. Drives BOTH the note and the button-disable.
  const extractionInProgress = extractionState === 'extracting' || extractionState === 'ocr_in_progress';
  // "Nothing new to process" (Ryan 2026-06-16, cost): every file is already read (ready=true) and no run
  // is active → a reprocess would just re-read already-read docs = wasted API spend. Gray the button +
  // say so. A FAILED/unread file makes ready=false → the button stays enabled (reprocess is useful then).
  const nothingToProcess = readiness.data?.data?.ready === true && !extractionInProgress;

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
  async function onReprocess(documentIds?: readonly string[]) {
    if (!targetCaseId) { setStatus('Create or select a case before reprocessing.'); return; }
    setBusy(true);
    setConfirming(false);
    try {
      setStatus('Reprocessing documents…');
      const { data } = await reprocessCase(targetCaseId, documentIds);
      // Plain-language. reocrQueued = how many files are being re-read; the chart re-extract then re-runs.
      const n = data.reocrQueued;
      let msg: string;
      if (data.extractEnqueued || data.extractReason === 'ocr_in_progress') {
        msg = `Re-reading ${n} file${n === 1 ? '' : 's'} with full vision and re-running the chart extraction (~5–10 min). SC Conditions update when it finishes.`;
        justFiredRef.current = Date.now(); // nudge the poll to catch the chart_ready→extracting flip
        forcePoll((n) => n + 1);
      } else {
        msg = `Chart re-extract did not start (${data.extractReason ?? 'unknown'}).`;
      }
      if (data.reocrFailed && data.reocrFailed.length > 0) {
        msg += ` ${data.reocrFailed.length} could not be re-read — ${data.reocrFailed.map((f) => `${f.documentId}: ${f.reason}`).join('; ')}.`;
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
        {/* Reprocess opens a document picker (re-reads the selected files with vision + re-extracts).
            Always available — re-reading unchanged files is exactly the Dorsey/Stephens case (the files
            were fine, the earlier read missed content). (Ryan 2026-06-13/16.) */}
        <button
          type="button"
          className="self-start rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          title={
            extractionInProgress ? 'A read/extraction is already running — wait for it to finish'
              : nothingToProcess ? 'Every file is already read — nothing new to process'
                : 'Re-read selected documents with full vision and re-run the chart extraction'
          }
          disabled={busy || extractionInProgress || nothingToProcess}
          onClick={() => setConfirming(true)}
        >
          {extractionInProgress ? 'Reprocessing…' : 'Reprocess documents'}
        </button>
      </div>
      {/* Cost guard (Ryan 2026-06-16): when everything's already read, the button is grayed + we say so,
          so nobody re-spends re-reading unchanged files. A subtle escape stays for the rare force re-read. */}
      {nothingToProcess && !busy ? (
        <p className="mt-2 text-sm text-slate-500">
          No new files to process.{' '}
          <button type="button" onClick={() => setConfirming(true)} className="text-slate-400 hover:text-sky-700 hover:underline">Re-read anyway</button>
        </p>
      ) : null}

      {/* Reprocess picker — all files selected by default; uncheck to re-read only what changed. Calm
          neutral modal, bold for the count, no red. */}
      {confirming ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" role="dialog" aria-modal="true" aria-label="Reprocess documents">
          <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-5 shadow-lg">
            <h3 className="text-base font-semibold text-slate-800">Reprocess documents</h3>
            <p className="mt-1 text-sm text-slate-500">
              Re-reads the selected files with full vision and re-runs the chart extraction. All files are
              selected by default — uncheck any you don’t need to re-read to save time. Takes about 5–10 minutes.
            </p>
            {docPicker.isLoading ? (
              <p className="mt-4 text-sm text-slate-500">Loading documents…</p>
            ) : caseDocs.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">No documents on this claim yet.</p>
            ) : (
              <>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">{selectedDocIds.size} of {caseDocs.length} selected</span>
                  <button type="button" className="text-sm text-sky-700 hover:underline" onClick={toggleAll}>
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2">
                  {caseDocs.map((d) => (
                    <li key={d.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-slate-700 hover:bg-slate-50">
                        <input type="checkbox" checked={selectedDocIds.has(d.id)} onChange={() => toggleDoc(d.id)} />
                        <span className="truncate">{d.filename}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md border border-slate-800 bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                disabled={busy || selectedDocIds.size === 0 || extractionInProgress}
                onClick={() => void onReprocess([...selectedDocIds])}
              >
                Reprocess {selectedDocIds.size} {selectedDocIds.size === 1 ? 'file' : 'files'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {status ? <p className="mt-2 text-sm text-slate-500">{status}</p> : null}
      {/* Live processing note — SERVER-derived (extractionInProgress), so it SURVIVES navigating away and
          back (the bug: it used to live in local state and vanished on remount). The button above is
          grayed whenever this is showing. No persistent "Done" banner — the note simply clears and the
          SC Conditions update; calm by design. */}
      {extractionInProgress ? (
        <p className="mt-2 text-sm text-sky-700">Reading and extracting the chart… (about 5&ndash;10 minutes). You can leave this page &mdash; it keeps running.</p>
      ) : Date.now() - justFiredRef.current < 60_000 && extractionState !== 'extract_failed' ? (
        <p className="mt-2 text-sm text-sky-700">Starting&hellip; (about 5&ndash;10 minutes). You can leave this page &mdash; it keeps running.</p>
      ) : extractionState === 'extract_failed' ? (
        <p className="mt-2 text-sm font-medium text-amber-700">Extraction didn&rsquo;t finish. Reprocess to try again, or override on the draft panel.</p>
      ) : null}
    </>
  );
}
