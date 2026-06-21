import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { TabSection } from '../../components/ui/TabSection';
import { DataRow } from '../../components/ui/DataRow';
import { RowAction } from '../../components/ui/RowAction';
import { useAuth } from '../../auth/useAuth';
import { ConflictError } from '../../api/client';
import { formatRelativeTime } from '../../lib/date';
import { createChartNote, deleteChartNote, listChartNotes, patchChartNote, type ChartNote } from '../../api/chart-notes';

const MAX = 5000;
const QUICK_MAX = 280; // a quick note is a few short sentences (the "sticky"); long notes use the full box.

export function ChartNotesPanel({ veteranId }: { readonly veteranId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [quickDraft, setQuickDraft] = useState('');
  const notesQuery = useQuery({ queryKey: ['chart-notes', veteranId], queryFn: () => listChartNotes(veteranId), enabled: veteranId.length > 0 });
  // Invalidate BOTH the stream and the dashboard "latest quick note" so the surfaced line refreshes too.
  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['chart-notes', veteranId] });
    await qc.invalidateQueries({ queryKey: ['chart-notes-latest-quick', veteranId] });
  };
  const create = useMutation({ mutationFn: (body: string) => createChartNote(veteranId, body), onSuccess: async () => { setDraft(''); await invalidate(); } });
  // The "sticky": a fast-add for SHORT notes that creates a flagged quick note in this SAME stream.
  const createQuick = useMutation({ mutationFn: (body: string) => createChartNote(veteranId, body, true), onSuccess: async () => { setQuickDraft(''); await invalidate(); } });

  const notes = notesQuery.data?.data ?? [];

  return <div>
    {/* Quick-note "sticky" — fast-add for a short note (a few sentences). It is NOT a separate section:
        it drops a flagged quick note into the SAME chronological stream below, marked with a badge. */}
    <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">Quick note</span>
        <span className="text-xs text-amber-700/80">Short, at-a-glance — surfaced on the case Overview. Saves into the notes list below.</span>
      </div>
      <div className="flex items-start gap-2">
        <input className="input flex-1 text-sm" maxLength={QUICK_MAX} placeholder="e.g. Awaiting records — C-file requested 6/8" value={quickDraft}
          onChange={(e) => setQuickDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && quickDraft.trim()) { e.preventDefault(); createQuick.mutate(quickDraft.trim()); } }} />
        <Button size="sm" onClick={() => createQuick.mutate(quickDraft.trim())} disabled={!quickDraft.trim()} loading={createQuick.isPending}>Add</Button>
      </div>
    </div>
    <div className="space-y-2">
      <textarea className="input min-h-20" maxLength={MAX} placeholder="Add a note anyone with chart access can see…" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="flex justify-end"><Button size="sm" onClick={() => create.mutate(draft.trim())} disabled={!draft.trim()} loading={create.isPending}>Save note</Button></div>
    </div>
    <div className="mt-4">
      {notesQuery.isLoading ? <p className="text-sm text-steel">Loading notes…</p> : null}
      {!notesQuery.isLoading && notes.length === 0 ? <EmptyState title="No notes yet" message="No notes yet. Add the first one above." /> : null}
      {notes.length > 0 ? <TabSection>{notes.map((n) => <NoteRow key={n.id} note={n} canEdit={user?.role === 'admin' || n.createdBy === user?.sub} canDelete={user?.role === 'admin'} onChanged={invalidate} />)}</TabSection> : null}
    </div>
  </div>;
}

function NoteRow({ note, canEdit, canDelete, onChanged }: { readonly note: ChartNote; readonly canEdit: boolean; readonly canDelete: boolean; readonly onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const patch = useMutation({
    mutationFn: () => patchChartNote(note.id, { version: note.version, body: draft.trim() }),
    onSuccess: async () => { setEditing(false); await onChanged(); },
    onError: async (err) => { if (err instanceof ConflictError) { await onChanged(); window.alert('This note was updated elsewhere. Reloaded — please retry.'); } },
  });
  const del = useMutation({ mutationFn: () => deleteChartNote(note.id), onSuccess: () => onChanged() });

  if (editing) {
    return <div className="px-5 py-3.5">
      <div className="space-y-2"><textarea className="input min-h-20" maxLength={MAX} value={draft} onChange={(e) => setDraft(e.target.value)} /><div className="flex justify-end gap-2"><RowAction onClick={() => { setDraft(note.body); setEditing(false); }}>Cancel</RowAction><RowAction onClick={() => patch.mutate()} disabled={!draft.trim() || patch.isPending}>Save</RowAction></div></div>
      <div className="mt-1"><span className="text-xs text-steel">Added by {note.createdByName ?? note.createdBy} · {formatRelativeTime(note.createdAt)}</span></div>
    </div>;
  }
  return <DataRow
    lead={<span className="block whitespace-pre-wrap font-normal text-slateInk">
      {note.isQuickNote ? <span className="mr-1.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-700">Quick note</span> : null}
      {note.body}
    </span>}
    meta={`Added by ${note.createdByName ?? note.createdBy} · ${formatRelativeTime(note.createdAt)}`}
    {...((canEdit || canDelete) ? { trailing: <>
      {canEdit ? <RowAction aria-label="Edit note" onClick={() => { setDraft(note.body); setEditing(true); }}>Edit</RowAction> : null}
      {canDelete ? <RowAction kind="danger" aria-label="Delete note" onClick={() => { if (window.confirm('Delete this note?')) del.mutate(); }}>Delete</RowAction> : null}
    </> } : {})}
  />;
}
