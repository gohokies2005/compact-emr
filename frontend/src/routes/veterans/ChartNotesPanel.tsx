import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
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
      {notesQuery.isLoading ? <p className="text-sm text-slate-500">Loading notes…</p> : null}
      {!notesQuery.isLoading && notes.length === 0 ? <EmptyState title="No notes yet" message="No notes yet. Add the first one above." /> : null}
      <div className="divide-y divide-slate-100">{notes.map((n) => <NoteRow key={n.id} note={n} canEdit={user?.role === 'admin' || n.createdBy === user?.sub} canDelete={user?.role === 'admin'} onChanged={invalidate} />)}</div>
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

  return <div className="py-3">
    {editing
      ? <div className="space-y-2"><textarea className="input min-h-20" maxLength={MAX} value={draft} onChange={(e) => setDraft(e.target.value)} /><div className="flex justify-end gap-2"><button type="button" className="text-xs text-slate-500" onClick={() => { setDraft(note.body); setEditing(false); }}>Cancel</button><button type="button" className="text-xs text-indigo-600" onClick={() => patch.mutate()} disabled={!draft.trim() || patch.isPending}>Save</button></div></div>
      : <p className="whitespace-pre-wrap text-sm text-slate-800">{note.body}</p>}
    <div className="mt-1 flex items-center justify-between">
      <span className="text-xs text-slate-400">Added by {note.createdBy} · {formatRelativeTime(note.createdAt)}</span>
      {!editing
        ? <div className="flex gap-3">{canEdit ? <button type="button" aria-label="Edit note" className="text-xs text-indigo-600" onClick={() => { setDraft(note.body); setEditing(true); }}>Edit</button> : null}{canDelete ? <button type="button" aria-label="Delete note" className="text-xs text-rose-600" onClick={() => { if (window.confirm('Delete this note?')) del.mutate(); }}>Delete</button> : null}</div>
        : null}
    </div>
  </div>;
}
