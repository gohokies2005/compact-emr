import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { ConflictError } from '../../api/client';
import { PhysicianSignatureControl } from '../../components/PhysicianSignatureControl';
import {
  createPhysician,
  listPhysicians,
  updatePhysician,
  type CreatePhysicianInput,
  type PhysicianPublic,
  type UpdatePhysicianFields,
} from '../../api/physicians';

interface PhysicianFormState {
  readonly fullName: string;
  readonly npi: string;
  readonly specialty: string;
  readonly medicalLicense: string;
  readonly email: string;
  readonly phone: string;
  readonly cognitoSub: string;
}

const EMPTY_FORM: PhysicianFormState = { fullName: '', npi: '', specialty: '', medicalLicense: '', email: '', phone: '', cognitoSub: '' };

function toCreateInput(form: PhysicianFormState): CreatePhysicianInput {
  return {
    fullName: form.fullName.trim(),
    npi: form.npi.trim(),
    specialty: form.specialty.trim(),
    medicalLicense: form.medicalLicense.trim(),
    email: form.email.trim(),
    ...(form.phone.trim() && { phone: form.phone.trim() }),
    ...(form.cognitoSub.trim() && { cognitoSub: form.cognitoSub.trim() }),
  };
}

function toEditForm(physician: PhysicianPublic): PhysicianFormState {
  return {
    fullName: physician.fullName,
    npi: physician.npi,
    specialty: physician.specialty,
    medicalLicense: physician.medicalLicense,
    email: physician.email,
    phone: physician.phone ?? '',
    cognitoSub: physician.cognitoSub ?? '',
  };
}

function toUpdateFields(original: PhysicianPublic, form: PhysicianFormState): UpdatePhysicianFields {
  const fields: { -readonly [K in keyof UpdatePhysicianFields]: UpdatePhysicianFields[K] } = {};
  if (form.fullName.trim() !== original.fullName) fields.fullName = form.fullName.trim();
  if (form.npi.trim() !== original.npi) fields.npi = form.npi.trim();
  if (form.specialty.trim() !== original.specialty) fields.specialty = form.specialty.trim();
  if (form.medicalLicense.trim() !== original.medicalLicense) fields.medicalLicense = form.medicalLicense.trim();
  if (form.email.trim() !== original.email) fields.email = form.email.trim();
  const phone = form.phone.trim() || null;
  if (phone !== original.phone) fields.phone = phone;
  const cognitoSub = form.cognitoSub.trim() || null;
  if (cognitoSub !== original.cognitoSub) fields.cognitoSub = cognitoSub;
  return fields;
}

function isCreateValid(form: PhysicianFormState): boolean {
  return (
    form.fullName.trim().length > 0 &&
    /^\d{10}$/.test(form.npi.trim()) &&
    form.specialty.trim().length > 0 &&
    form.medicalLicense.trim().length > 0 &&
    form.email.trim().length > 0
  );
}

function conflictMessage(error: unknown): string {
  if (!(error instanceof ConflictError)) return 'Request could not be completed. Please retry.';
  const current = error.current;
  if (current && typeof current === 'object' && 'field' in current && (current.field === 'npi' || current.field === 'cognitoSub')) {
    return current.field === 'npi' ? 'A physician with that NPI already exists.' : 'A physician with that Cognito subject already exists.';
  }
  if (current && typeof current === 'object' && 'inFlightCount' in current && typeof current.inFlightCount === 'number') {
    return `This physician has ${current.inFlightCount} in-flight case${current.inFlightCount === 1 ? '' : 's'} and cannot be deactivated.`;
  }
  return 'This physician was changed elsewhere. Reload and try again.';
}

function Field({ label, value, onChange, required = false, placeholder }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly required?: boolean; readonly placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-800">{label}{required ? <span className="text-rose-600"> *</span> : null}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200" />
    </label>
  );
}

export function PhysiciansPage() {
  const qc = useQueryClient();
  const [createForm, setCreateForm] = useState<PhysicianFormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<PhysicianPublic | null>(null);
  const [editForm, setEditForm] = useState<PhysicianFormState>(EMPTY_FORM);
  const [message, setMessage] = useState<string | null>(null);

  const physiciansQuery = useQuery({ queryKey: ['physicians'], queryFn: listPhysicians });
  const physicians = useMemo(() => physiciansQuery.data?.data ?? [], [physiciansQuery.data]);

  const createMutation = useMutation({
    mutationFn: () => createPhysician(toCreateInput(createForm)),
    onSuccess: async () => { setCreateForm(EMPTY_FORM); setMessage('Physician created.'); await qc.invalidateQueries({ queryKey: ['physicians'] }); },
    onError: (error: unknown) => setMessage(conflictMessage(error)),
  });

  const editMutation = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error('No physician selected.');
      return updatePhysician(editing.id, { version: editing.version, fields: toUpdateFields(editing, editForm) });
    },
    onSuccess: async () => { setEditing(null); setEditForm(EMPTY_FORM); setMessage('Physician updated.'); await qc.invalidateQueries({ queryKey: ['physicians'] }); },
    onError: (error: unknown) => setMessage(conflictMessage(error)),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (physician: PhysicianPublic) => updatePhysician(physician.id, { version: physician.version, fields: { active: !physician.active } }),
    onSuccess: async () => { setMessage('Physician status updated.'); await qc.invalidateQueries({ queryKey: ['physicians'] }); },
    onError: (error: unknown) => setMessage(conflictMessage(error)),
  });

  function updateCreateField<K extends keyof PhysicianFormState>(key: K, value: PhysicianFormState[K]) { setCreateForm((current) => ({ ...current, [key]: value })); setMessage(null); }
  function updateEditField<K extends keyof PhysicianFormState>(key: K, value: PhysicianFormState[K]) { setEditForm((current) => ({ ...current, [key]: value })); setMessage(null); }
  function openEdit(physician: PhysicianPublic) { setEditing(physician); setEditForm(toEditForm(physician)); setMessage(null); }
  function handleCreate(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (isCreateValid(createForm)) createMutation.mutate(); }
  function handleEdit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); editMutation.mutate(); }

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Physicians</h1>
          <p className="mt-2 text-sm text-slate-600">Manage physician profiles, Cognito mapping, active status, and signature readiness.</p>
        </div>

        {message ? <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message}</div> : null}

        <Card>
          <h2 className="text-base font-semibold text-slate-900">New physician</h2>
          <form onSubmit={handleCreate} className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Field label="Full name" value={createForm.fullName} onChange={(v) => updateCreateField('fullName', v)} required />
            <Field label="NPI" value={createForm.npi} onChange={(v) => updateCreateField('npi', v)} required placeholder="10 digits" />
            <Field label="Specialty" value={createForm.specialty} onChange={(v) => updateCreateField('specialty', v)} required />
            <Field label="Medical license" value={createForm.medicalLicense} onChange={(v) => updateCreateField('medicalLicense', v)} required />
            <Field label="Email" value={createForm.email} onChange={(v) => updateCreateField('email', v)} required />
            <Field label="Phone" value={createForm.phone} onChange={(v) => updateCreateField('phone', v)} />
            <div className="md:col-span-2 xl:col-span-3">
              <Field label="Cognito subject" value={createForm.cognitoSub} onChange={(v) => updateCreateField('cognitoSub', v)} placeholder="Optional until user account is linked" />
            </div>
            <div className="md:col-span-2 xl:col-span-3">
              <Button type="submit" variant="primary" loading={createMutation.isPending} disabled={!isCreateValid(createForm) || createMutation.isPending}>Create physician</Button>
            </div>
          </form>
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-slate-900">Physician profiles</h2>
          <p className="mt-1 text-sm text-slate-600">Active physicians are eligible for assignment.</p>

          {physiciansQuery.isLoading ? <div className="mt-6 flex items-center gap-2 text-sm text-slate-500"><Spinner />Loading physicians</div> : null}
          {!physiciansQuery.isLoading && physicians.length === 0 ? <div className="mt-6"><EmptyState message="No physicians found." /></div> : null}

          {physicians.length > 0 ? (
            <div className="mt-6 overflow-hidden rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-3">Physician</th><th className="px-4 py-3">NPI</th><th className="px-4 py-3">Specialty</th><th className="px-4 py-3">Active</th><th className="px-4 py-3">Signature</th><th className="px-4 py-3">Version</th><th className="px-4 py-3" /></tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {physicians.map((physician) => (
                    <tr key={physician.id}>
                      <td className="px-4 py-3"><div className="font-medium text-slate-900">{physician.fullName}</div><div className="text-xs text-slate-500">{physician.email}</div></td>
                      <td className="px-4 py-3 text-slate-700">{physician.npi}</td>
                      <td className="px-4 py-3 text-slate-700">{physician.specialty}</td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${physician.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>{physician.active ? 'Active' : 'Inactive'}</span></td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${physician.hasSignature ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{physician.hasSignature ? 'Signature ready' : 'Missing'}</span></td>
                      <td className="px-4 py-3 text-slate-500">v{physician.version}</td>
                      <td className="px-4 py-3"><div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => openEdit(physician)}>Edit</Button><Button type="button" variant="ghost" loading={toggleActiveMutation.isPending} disabled={toggleActiveMutation.isPending} onClick={() => toggleActiveMutation.mutate(physician)}>{physician.active ? 'Deactivate' : 'Activate'}</Button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>

        {editing ? (
          <div role="dialog" aria-modal="true" aria-labelledby="edit-physician-title">
            <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" />
            <div className="fixed right-0 top-0 z-50 h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div><h2 id="edit-physician-title" className="text-lg font-semibold text-slate-900">Edit physician</h2><p className="mt-1 text-sm text-slate-600">Updating version {editing.version}.</p></div>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Close</Button>
              </div>
              <form onSubmit={handleEdit} className="mt-6 space-y-4">
                <Field label="Full name" value={editForm.fullName} onChange={(v) => updateEditField('fullName', v)} required />
                <Field label="NPI" value={editForm.npi} onChange={(v) => updateEditField('npi', v)} required />
                <Field label="Specialty" value={editForm.specialty} onChange={(v) => updateEditField('specialty', v)} required />
                <Field label="Medical license" value={editForm.medicalLicense} onChange={(v) => updateEditField('medicalLicense', v)} required />
                <Field label="Email" value={editForm.email} onChange={(v) => updateEditField('email', v)} required />
                <Field label="Phone" value={editForm.phone} onChange={(v) => updateEditField('phone', v)} />
                <Field label="Cognito subject" value={editForm.cognitoSub} onChange={(v) => updateEditField('cognitoSub', v)} />
                <PhysicianSignatureControl physician={editing} />
                <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                  <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                  <Button type="submit" variant="primary" loading={editMutation.isPending} disabled={editMutation.isPending}>Save changes</Button>
                </div>
              </form>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
