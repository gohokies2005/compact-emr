import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import { ConflictError } from '../../api/client';
import { listUsers, createStaff, setStaffActive, type StaffRole, type CreateStaffInput, type StaffUser } from '../../api/users';

const ROLE_OPTIONS: ReadonlyArray<{ value: StaffRole; label: string }> = [
  { value: 'ops_staff', label: 'RN / Ops staff' },
  { value: 'physician', label: 'Physician (can sign)' },
  { value: 'admin', label: 'Admin (full access)' },
];

interface FormState {
  email: string; name: string; roles: StaffRole[];
  credential: 'invite' | 'temp_password'; tempPassword: string;
  npi: string; specialty: string; medicalLicense: string;
  boardName: string; boardAbbreviation: string; licenseState: string; licenseNumber: string; phone: string;
}
const EMPTY: FormState = {
  email: '', name: '', roles: ['ops_staff'], credential: 'invite', tempPassword: '',
  npi: '', specialty: '', medicalLicense: '', boardName: '', boardAbbreviation: '', licenseState: '', licenseNumber: '', phone: '',
};

function toInput(f: FormState): CreateStaffInput {
  const base: CreateStaffInput = {
    email: f.email.trim().toLowerCase(),
    name: f.name.trim(),
    roles: f.roles,
    credential: f.credential,
    ...(f.credential === 'temp_password' ? { tempPassword: f.tempPassword } : {}),
  };
  if (!f.roles.includes('physician')) return base;
  return {
    ...base,
    physician: {
      npi: f.npi.trim(), specialty: f.specialty.trim(), medicalLicense: f.medicalLicense.trim(),
      boardName: f.boardName.trim(), boardAbbreviation: f.boardAbbreviation.trim(),
      licenseState: f.licenseState.trim(), licenseNumber: f.licenseNumber.trim(),
      ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
    },
  };
}

function isValid(f: FormState): boolean {
  if (f.name.trim().length === 0 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim()) || f.roles.length === 0) return false;
  if (f.credential === 'temp_password' && !(f.tempPassword.length >= 8 && /[A-Za-z]/.test(f.tempPassword) && /[0-9]/.test(f.tempPassword) && /[^A-Za-z0-9]/.test(f.tempPassword))) return false;
  if (f.roles.includes('physician')) {
    if (!/^\d{10}$/.test(f.npi.trim())) return false;
    for (const v of [f.specialty, f.medicalLicense, f.boardName, f.boardAbbreviation, f.licenseState, f.licenseNumber]) if (v.trim().length === 0) return false;
  }
  return true;
}

function Field({ label, value, onChange, required, placeholder, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; placeholder?: string; type?: string }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-800">{label}{required ? <span className="text-rose-600"> *</span> : null}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200" />
    </label>
  );
}

export function StaffPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [message, setMessage] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { setForm((c) => ({ ...c, [k]: v })); setMessage(null); };

  const usersQuery = useQuery({ queryKey: ['users', 'all'], queryFn: () => listUsers({ includeInactive: true }) });
  const staff = useMemo(() => usersQuery.data?.data ?? [], [usersQuery.data]);
  const wantsPhysician = form.roles.includes('physician');

  const createMutation = useMutation({
    mutationFn: () => createStaff(toInput(form)),
    onSuccess: async (res) => {
      const extra = res.data.physicianId ? ' Physician profile created — upload their signature next (Physicians page).' : '';
      setMessage(`Staff added: ${res.data.email}.${extra}`);
      setForm(EMPTY);
      await qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e: unknown) => setMessage(e instanceof ConflictError ? 'That email or NPI already exists.' : 'Could not add staff. Retry — provisioning is safe to repeat.'),
  });

  const toggleMutation = useMutation({
    mutationFn: (vars: { user: StaffUser; active: boolean }) => setStaffActive(vars.user.id, vars.user.version, vars.active),
    onSuccess: async () => { setMessage('Staff status updated.'); await qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e: unknown) => setMessage(e instanceof ConflictError ? 'This user changed elsewhere, or has in-flight cases — reassign first.' : 'Could not update status.'),
  });

  function handleCreate(e: FormEvent<HTMLFormElement>) { e.preventDefault(); if (isValid(form)) createMutation.mutate(); }

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Staff</h1>
          <p className="mt-1 text-sm text-slate-600">Add RNs, physicians, and admins. Each gets their own login. Use "temporary password" for test accounts you want to sign into immediately; "invite email" for real staff.</p>
        </div>

        {message ? <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message}</div> : null}

        <Card>
          <h2 className="text-base font-semibold text-slate-900">Add staff</h2>
          <form onSubmit={handleCreate} className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Field label="Full name" value={form.name} onChange={(v) => set('name', v)} required placeholder='e.g. "ZZZ Physician, DO" (prints on the letter)' />
            <Field label="Email (login)" value={form.email} onChange={(v) => set('email', v)} required />
            <div>
              <span className="text-sm font-medium text-slate-800">Roles<span className="text-rose-600"> *</span></span>
              <div className="mt-2 space-y-1">
                {ROLE_OPTIONS.map((r) => (
                  <label key={r.value} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={form.roles.includes(r.value)} onChange={(e) => set('roles', e.target.checked ? [...form.roles, r.value] : form.roles.filter((x) => x !== r.value))} />
                    {r.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="md:col-span-2 xl:col-span-3 border-t border-slate-200 pt-3">
              <span className="text-sm font-medium text-slate-800">Credential</span>
              <div className="mt-2 flex flex-wrap gap-4 text-sm text-slate-700">
                <label className="flex items-center gap-2"><input type="radio" name="cred" checked={form.credential === 'invite'} onChange={() => set('credential', 'invite')} />Send invite email</label>
                <label className="flex items-center gap-2"><input type="radio" name="cred" checked={form.credential === 'temp_password'} onChange={() => set('credential', 'temp_password')} />Set temporary password (test users)</label>
              </div>
              {form.credential === 'temp_password' ? <div className="mt-2 max-w-md"><Field label="Temporary password" value={form.tempPassword} onChange={(v) => set('tempPassword', v)} required type="text" placeholder=">=8 chars, a letter, number, and symbol" /></div> : null}
            </div>

            {wantsPhysician ? (
              <div className="md:col-span-2 xl:col-span-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="md:col-span-2 xl:col-span-3 text-sm font-semibold text-slate-900">Physician credentials (printed on the letter; full name + email reuse the fields above)</div>
                <Field label="NPI" value={form.npi} onChange={(v) => set('npi', v)} required placeholder="10 digits" />
                <Field label="Specialty" value={form.specialty} onChange={(v) => set('specialty', v)} required />
                <Field label="Medical license" value={form.medicalLicense} onChange={(v) => set('medicalLicense', v)} required />
                <Field label="Certifying board" value={form.boardName} onChange={(v) => set('boardName', v)} required placeholder="e.g. American Board of Osteopathic Family Physicians" />
                <Field label="Board abbreviation" value={form.boardAbbreviation} onChange={(v) => set('boardAbbreviation', v)} required placeholder="e.g. ABOFP" />
                <Field label="License state" value={form.licenseState} onChange={(v) => set('licenseState', v)} required placeholder="e.g. Nevada" />
                <Field label="License number" value={form.licenseNumber} onChange={(v) => set('licenseNumber', v)} required placeholder="e.g. DO2996" />
                <Field label="Phone" value={form.phone} onChange={(v) => set('phone', v)} />
              </div>
            ) : null}

            <div className="md:col-span-2 xl:col-span-3">
              <Button type="submit" variant="primary" loading={createMutation.isPending} disabled={!isValid(form) || createMutation.isPending}>Add staff</Button>
            </div>
          </form>
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-slate-900">Staff accounts</h2>
          {usersQuery.isLoading ? <div className="mt-6 flex items-center gap-2 text-sm text-slate-500"><Spinner />Loading staff</div> : null}
          {!usersQuery.isLoading && staff.length === 0 ? <div className="mt-6"><EmptyState message="No staff yet." /></div> : null}
          {staff.length > 0 ? (
            <div className="mt-6 overflow-hidden rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Roles</th><th className="px-4 py-3">Active</th><th className="px-4 py-3" /></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {staff.map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-3 text-slate-900">{s.name ?? '-'}</td>
                      <td className="px-4 py-3 text-slate-600">{s.email}</td>
                      <td className="px-4 py-3 text-slate-600">{s.roles.join(', ')}</td>
                      <td className="px-4 py-3">{s.active ? <span className="text-emerald-700">Active</span> : <span className="text-slate-400">Inactive</span>}</td>
                      <td className="px-4 py-3 text-right">
                        <Button type="button" variant="ghost" disabled={toggleMutation.isPending} onClick={() => toggleMutation.mutate({ user: s, active: !s.active })}>{s.active ? 'Deactivate' : 'Reactivate'}</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
      </div>
    </AppShell>
  );
}
