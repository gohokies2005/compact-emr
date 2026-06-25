import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { SectionCard } from './ui/SectionCard';
import { Spinner } from './ui/Spinner';
import { ConflictError } from '../api/client';
import { assignCasePhysician, assignCaseRn, getCase, type CaseDetail } from '../api/cases';
import { listPhysicians, type PhysicianPublic } from '../api/physicians';
import { listUsers } from '../api/users';

// The assign endpoints are optimistic-locked on the case `version`. A background poll
// (chart-extract / readiness / case refetch) routinely bumps that version between page-load
// and the click, so the `version` captured at render is frequently stale by the time the RN
// presses Assign — the server 409s ("Case version is stale") and, before this, the RN saw
// "This case changed elsewhere" and had to retry by hand (it only "worked after waiting" when a
// refetch happened to land first). Fix: read the freshest version we have at submit time, and on
// a 409 refetch the case ONCE to learn the true server version and retry the assignment once.
// Only a SECOND 409 (a genuine concurrent edit) surfaces to the RN. Single retry — never a loop.

// Freshest version we currently know for this case: the live ['case', caseId] query cache (kept
// current by the same background polls that cause the stale-prop) falling back to the prop.
function freshestVersion(qc: QueryClient, caseId: string, fallback: number): number {
  const cached = qc.getQueryData<{ data: CaseDetail }>(['case', caseId]);
  const v = cached?.data?.version;
  return typeof v === 'number' ? v : fallback;
}

// Run an assignment that is version-checked, auto-recovering from a routine optimistic-lock 409.
// `assign(version)` performs the PATCH for a given version. On a 409 we refetch the case to get the
// authoritative server version, seed the cache, and retry the assignment exactly once with it.
async function assignWithVersionRetry(
  qc: QueryClient,
  caseId: string,
  initialVersion: number,
  assign: (version: number) => Promise<unknown>,
): Promise<void> {
  try {
    await assign(initialVersion);
    return;
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    // Routine background-poll version bump: learn the true version straight from the server,
    // seed the cache so the rest of the page agrees, and retry once.
    const fresh = await getCase(caseId);
    qc.setQueryData(['case', caseId], fresh);
    await assign(fresh.data.version);
  }
}

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
  const [selectedRnId, setSelectedRnId] = useState(assignedRn?.id ?? '');
  const [message, setMessage] = useState<string | null>(null);

  const physiciansQuery = useQuery({ queryKey: ['physicians'], queryFn: listPhysicians });
  const physicians = useMemo(() => activePhysicians(physiciansQuery.data?.data ?? []), [physiciansQuery.data]);

  const rnsQuery = useQuery({ queryKey: ['users', 'ops_staff'], queryFn: () => listUsers({ role: 'ops_staff' }) });
  const rns = useMemo(() => rnsQuery.data?.data ?? [], [rnsQuery.data]);

  const invalidateCase = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['case', caseId] }), qc.invalidateQueries({ queryKey: ['cases'] })]);
  };

  const assignPhysicianMutation = useMutation({
    mutationFn: () =>
      assignWithVersionRetry(qc, caseId, freshestVersion(qc, caseId, version), (v) =>
        assignCasePhysician(caseId, { physicianId: selectedPhysicianId, version: v }),
      ),
    onSuccess: async () => { setMessage('Physician assignment updated.'); await invalidateCase(); },
    onError: (error: unknown) => {
      setMessage(error instanceof ConflictError ? 'This case was just updated by someone else — reload and try again.' : 'Physician could not be assigned. Please retry.');
    },
  });

  const assignRnMutation = useMutation({
    mutationFn: () =>
      assignWithVersionRetry(qc, caseId, freshestVersion(qc, caseId, version), (v) =>
        assignCaseRn(caseId, { rnUserId: selectedRnId, version: v }),
      ),
    onSuccess: async () => { setMessage('RN liaison assignment updated.'); await invalidateCase(); },
    onError: (error: unknown) => {
      setMessage(error instanceof ConflictError ? 'This case was just updated by someone else — reload and try again.' : 'RN liaison could not be assigned. Please retry.');
    },
  });

  const canAssignPhysician = selectedPhysicianId.length > 0 && selectedPhysicianId !== assignedPhysician?.id && !assignPhysicianMutation.isPending;
  const canAssignRn = selectedRnId.length > 0 && selectedRnId !== assignedRn?.id && !assignRnMutation.isPending;

  return (
    <SectionCard title="Assignments">
      <p className="text-sm text-steel">Assign the physician reviewer and the RN liaison for this case.</p>

      {message ? <div className="mt-4 rounded-xl border border-aegis bg-mistSoft p-3 text-sm text-steel">{message}</div> : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-aegis bg-mistSoft p-4">
          <div className="text-sm font-semibold text-navyDeep">Assigned physician</div>
          <p className="mt-1 text-sm text-steel">{assignedPhysician ? `${assignedPhysician.fullName} · ${assignedPhysician.email}` : 'No physician assigned.'}</p>
          <label className="mt-4 block">
            <span className="text-sm font-medium text-navyDeep">Assign or reassign physician</span>
            <select value={selectedPhysicianId} onChange={(e) => { setSelectedPhysicianId(e.target.value); setMessage(null); }} className="mt-2 w-full rounded-lg border border-aegis bg-ivory px-3 py-2 text-sm text-navyDeep shadow-sm focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/30">
              <option value="">Select physician</option>
              {physicians.map((p) => <option key={p.id} value={p.id}>{p.fullName} · {p.specialty}</option>)}
            </select>
          </label>
          {physiciansQuery.isLoading ? <div className="mt-3 flex items-center gap-2 text-sm text-steel"><Spinner />Loading physicians</div> : null}
          <div className="mt-4">
            <Button type="button" variant="primary" loading={assignPhysicianMutation.isPending} disabled={!canAssignPhysician} onClick={() => assignPhysicianMutation.mutate()}>
              {assignedPhysician ? 'Reassign physician' : 'Assign physician'}
            </Button>
          </div>
        </div>

        <div className="rounded-2xl border border-aegis bg-mistSoft p-4">
          <div className="text-sm font-semibold text-navyDeep">Assigned RN liaison</div>
          <p className="mt-1 text-sm text-steel">{assignedRn ? assignedRn.email : 'No RN liaison assigned.'}</p>
          <label className="mt-4 block">
            <span className="text-sm font-medium text-navyDeep">Assign or reassign RN</span>
            <select value={selectedRnId} aria-label="Assign or reassign RN" onChange={(e) => { setSelectedRnId(e.target.value); setMessage(null); }} className="mt-2 w-full rounded-lg border border-aegis bg-ivory px-3 py-2 text-sm text-navyDeep shadow-sm focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/30">
              <option value="">Select RN liaison</option>
              {rns.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
            </select>
          </label>
          {rnsQuery.isLoading ? <div className="mt-3 flex items-center gap-2 text-sm text-steel"><Spinner />Loading staff</div> : null}
          <div className="mt-4">
            <Button type="button" variant="primary" loading={assignRnMutation.isPending} disabled={!canAssignRn} onClick={() => assignRnMutation.mutate()}>
              {assignedRn ? 'Reassign RN' : 'Assign RN'}
            </Button>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
