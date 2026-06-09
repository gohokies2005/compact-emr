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

export function ChartNotesPanel({ veteranId }: { readonly veteranId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const notesQuery = useQuery({ queryKey: ['chart-notes', veteranId], queryFn: () => listChartNotes(veteranId), enabled: veteranId.length > 0 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['chart-notes', veteranId] });
  const create = useMutation({ mutationFn: (body: string) => createChartNote(veteranId, body), onSuccess: async () => { setDraft(''); await invalidate(); } });

  const notes = notesQuery.data?.data ?? [];

  return <div>
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
      <div className="mt-1"><span className="text-xs text-steel">Added by {note.createdBy} · {formatRelativeTime(note.createdAt)}</span></div>
    </div>;
  }
  return <DataRow
    lead={<span className="block whitespace-pre-wrap font-normal text-slateInk">{note.body}</span>}
    meta={`Added by ${note.createdBy} · ${formatRelativeTime(note.createdAt)}`}
    {...((canEdit || canDelete) ? { trailing: <>
      {canEdit ? <RowAction aria-label="Edit note" onClick={() => { setDraft(note.body); setEditing(true); }}>Edit</RowAction> : null}
      {canDelete ? <RowAction kind="danger" aria-label="Delete note" onClick={() => { if (window.confirm('Delete this note?')) del.mutate(); }}>Delete</RowAction> : null}
    </> } : {})}
  />;
}
