import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Spinner } from './ui/Spinner';
import { ConflictError } from '../api/client';
import { assignCasePhysician } from '../api/cases';
import { listPhysicians, type PhysicianPublic } from '../api/physicians';

interface CaseAssignmentPanelProps {
  readonly caseId: string;
  readonly version: number;
  readonly assignedPhysician?: { readonly id: string; readonly fullName: string; readonly email: string } | null;
  readonly assignedRn?: { readonly id: string; readonly email: string } | null;
}

function activePhysicians(physicians: readonly PhysicianPublic[]): readonly PhysicianPublic[] {
  return physicians.filter((p) => p.active);
}

export function CaseAssignmentPanel({ caseId, version, assignedPhysician, assignedRn }: CaseAssignmentPanelProps) {
  const qc = useQueryClient();
  const [selectedPhysicianId, setSelectedPhysicianId] = useState(assignedPhysician?.id ?? '');
  const [message, setMessage] = useState<string | null>(null);

  const physiciansQuery = useQuery({ queryKey: ['physicians'], queryFn: listPhysicians });
  const physicians = useMemo(() => activePhysicians(physiciansQuery.data?.data ?? []), [physiciansQuery.data]);

  const assignPhysicianMutation = useMutation({
    mutationFn: () => assignCasePhysician(caseId, { physicianId: selectedPhysicianId, version }),
    onSuccess: async () => {
      setMessage('Physician assignment updated.');
      await Promise.all([qc.invalidateQueries({ queryKey: ['case', caseId] }), qc.invalidateQueries({ queryKey: ['cases'] })]);
    },
    onError: (error: unknown) => {
      setMessage(error instanceof ConflictError ? 'This case changed elsewhere. Reload and try the assignment again.' : 'Physician could not be assigned. Please retry.');
    },
  });

  const canAssignPhysician = selectedPhysicianId.length > 0 && selectedPhysicianId !== assignedPhysician?.id && !assignPhysicianMutation.isPending;

  return (
    <Card>
      <div>
        <h2 className="text-base font-semibold text-slate-900">Assignments</h2>
        <p className="mt-1 text-sm text-slate-600">Assign the physician reviewer. RN assignment will be available after the users endpoint ships.</p>
      </div>

      {message ? <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message}</div> : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-900">Assigned physician</div>
          <p className="mt-1 text-sm text-slate-600">{assignedPhysician ? `${assignedPhysician.fullName} · ${assignedPhysician.email}` : 'No physician assigned.'}</p>
          <label className="mt-4 block">
            <span className="text-sm font-medium text-slate-800">Assign or reassign physician</span>
            <select value={selectedPhysicianId} onChange={(e) => { setSelectedPhysicianId(e.target.value); setMessage(null); }} className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200">
              <option value="">Select physician</option>
              {physicians.map((p) => <option key={p.id} value={p.id}>{p.fullName} · {p.specialty}</option>)}
            </select>
          </label>
          {physiciansQuery.isLoading ? <div className="mt-3 flex items-center gap-2 text-sm text-slate-500"><Spinner />Loading physicians</div> : null}
          <div className="mt-4">
            <Button type="button" variant="primary" loading={assignPhysicianMutation.isPending} disabled={!canAssignPhysician} onClick={() => assignPhysicianMutation.mutate()}>
              {assignedPhysician ? 'Reassign physician' : 'Assign physician'}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 opacity-80">
          <div className="text-sm font-semibold text-slate-900">Assigned RN liaison</div>
          <p className="mt-1 text-sm text-slate-600">{assignedRn ? assignedRn.email : 'No RN liaison assigned.'}</p>
          <label className="mt-4 block">
            <span className="text-sm font-medium text-slate-800">Assign or reassign RN</span>
            <select disabled aria-label="Assign or reassign RN" className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-sm">
              <option>RN picker pending users endpoint</option>
            </select>
          </label>
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">The users-list endpoint is not available yet. This control is intentionally disabled.</div>
        </div>
      </div>
    </Card>
  );
}
