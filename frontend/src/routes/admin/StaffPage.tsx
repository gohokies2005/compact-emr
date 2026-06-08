import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../../layout/AppShell';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';
import axios from 'axios';
import { ConflictError, ForbiddenError, ServiceUnavailableError } from '../../api/client';
import { listUsers, createStaff, setStaffActive, resetStaffPassword, unlockStaff, type StaffRole, type CreateStaffInput, type StaffUser } from '../../api/users';

// Mirrors the backend Cognito password policy (assertCognitoPasswordPolicy) so the temp-password
// branch of the reset dialog blocks client-side instead of bouncing off a server 400.
function isStrongTempPassword(p: string): boolean {
  return p.length >= 12 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);
}

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

// Returns the first reason the form can't be submitted, or null when it's valid. Surfaced on
// click so the admin is never left with a silently-dead "Add staff" button.
function validationError(f: FormState): string | null {
  if (f.name.trim().length === 0) return 'Enter the full name.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) return 'Enter a valid email address.';
  if (f.roles.length === 0) return 'Pick at least one role.';
  if (f.credential === 'temp_password') {
    const p = f.tempPassword;
    if (!(p.length >= 12 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p))) {
      return 'Temporary password must be at least 12 characters with an uppercase letter, a lowercase letter, a number, and a symbol (e.g. FrnTest-2026!!).';
    }
  }
  if (f.roles.includes('physician')) {
    if (!/^\d{10}$/.test(f.npi.trim())) return 'Physician NPI must be exactly 10 digits.';
    for (const [label, v] of [['Specialty', f.specialty], ['Medical license', f.medicalLicense], ['Certifying board', f.boardName], ['Board abbreviation', f.boardAbbreviation], ['License state', f.licenseState], ['License number', f.licenseNumber]] as const) {
      if (v.trim().length === 0) return `Physician ${label} is required.`;
    }
  }
  return null;
}

// Surface the ACTUAL failure so a stuck "Add staff" is diagnosable instead of a useless generic.
function staffErrorMessage(e: unknown): string {
  if (e instanceof ConflictError) return 'That email or NPI already exists.';
  if (e instanceof ServiceUnavailableError) return 'Server says staff provisioning is not configured (503) — the API needs the Cognito pool wired.';
  if (e instanceof ForbiddenError) return 'Forbidden (403): your login is not recognized as an admin by the server.';
  if (axios.isAxiosError(e)) {
    const status = e.response?.status;
    const msg = (e.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    if (status) return `Add staff failed (HTTP ${status})${msg ? `: ${msg}` : ''}.`;
    return `Add staff failed (no response — network/CORS): ${e.message}`;
  }
  return 'Could not add staff. Retry — provisioning is safe to repeat.';
}

// Surface the real reason a per-row account action (reset / unlock) failed, including 404.
function accountActionError(e: unknown, label: string): string {
  if (e instanceof ServiceUnavailableError) return `${label} failed: the server says staff provisioning is not configured (503) — the Cognito pool needs wiring.`;
  if (e instanceof ForbiddenError) return `${label} failed (403): your login is not recognized as an admin by the server.`;
  if (axios.isAxiosError(e)) {
    const status = e.response?.status;
    const msg = (e.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    if (status === 404) return `${label} failed: that staff account no longer exists (404). Reload the list.`;
    if (status) return `${label} failed (HTTP ${status})${msg ? `: ${msg}` : ''}.`;
    return `${label} failed (no response — network/CORS): ${e.message}`;
  }
  return `${label} failed. Please retry.`;
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
  // Per-row account actions open one of these dialogs (target = the staffer being acted on).
  const [resetTarget, setResetTarget] = useState<StaffUser | null>(null);
  const [resetMode, setResetMode] = useState<'email_code' | 'temp_password'>('email_code');
  const [resetTempPassword, setResetTempPassword] = useState('');
  const [unlockTarget, setUnlockTarget] = useState<StaffUser | null>(null);
  const [unlockEmailConfirm, setUnlockEmailConfirm] = useState('');
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { setForm((c) => ({ ...c, [k]: v })); setMessage(null); };

  function closeReset() { setResetTarget(null); setResetMode('email_code'); setResetTempPassword(''); }
  function closeUnlock() { setUnlockTarget(null); setUnlockEmailConfirm(''); }

  const usersQuery = useQuery({ queryKey: ['users', 'all'], queryFn: () => listUsers({ includeInactive: true }) });
  const staff = useMemo(() => usersQuery.data?.data ?? [], [usersQuery.data]);
  const wantsPhysician = form.roles.includes('physician');

  const createMutation = useMutation({
    mutationFn: () => createStaff(toInput(form)),
    onSuccess: async (res) => {
      const extra = res.data.physicianId ? ' Physician profile created — upload their signature next (Physician credentials page).' : '';
      setMessage(`Staff added: ${res.data.email}.${extra}`);
      setForm(EMPTY);
      await qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e: unknown) => setMessage(staffErrorMessage(e)),
  });

  const toggleMutation = useMutation({
    mutationFn: (vars: { user: StaffUser; active: boolean }) => setStaffActive(vars.user.id, vars.user.version, vars.active),
    onSuccess: async () => { setMessage('Staff status updated.'); await qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e: unknown) => {
      if (e instanceof ConflictError) {
        const d = e.current as { inFlightCount?: number } | undefined;
        setMessage(typeof d?.inFlightCount === 'number'
          ? `Cannot deactivate: this user is the RN liaison on ${d.inFlightCount} in-flight case(s). Reassign them first.`
          : 'This user changed elsewhere. Reload and try again.');
        return;
      }
      setMessage('Could not update status.');
    },
  });

  const resetMutation = useMutation({
    mutationFn: (vars: { user: StaffUser; mode: 'email_code' | 'temp_password'; tempPassword: string }) =>
      resetStaffPassword(vars.user.id, vars.mode === 'temp_password' ? { mode: 'temp_password', tempPassword: vars.tempPassword } : {}),
    onSuccess: (_res, vars) => {
      setMessage(vars.mode === 'temp_password'
        ? `Temporary password set for ${vars.user.email}. They must change it at next sign-in.`
        : `Reset code emailed to ${vars.user.email}.`);
      closeReset();
    },
    onError: (e: unknown) => setMessage(accountActionError(e, 'Reset password')),
  });

  const unlockMutation = useMutation({
    mutationFn: (user: StaffUser) => unlockStaff(user.id),
    onSuccess: (res) => {
      setMessage(`MFA cleared and login re-enabled for ${res.data.email}.${res.data.targetIsAdmin ? ' (admin account — logged for audit)' : ''}`);
      closeUnlock();
    },
    onError: (e: unknown) => setMessage(accountActionError(e, 'Unlock')),
  });

  function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const err = validationError(form);
    if (err) { setMessage(err); return; }
    createMutation.mutate();
  }

  function submitReset() {
    if (!resetTarget) return;
    if (resetMode === 'temp_password' && !isStrongTempPassword(resetTempPassword)) {
      setMessage('Temporary password must be at least 12 characters with an uppercase letter, a lowercase letter, a number, and a symbol (e.g. FrnTest-2026!!).');
      return;
    }
    resetMutation.mutate({ user: resetTarget, mode: resetMode, tempPassword: resetTempPassword });
  }

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
              {form.credential === 'temp_password' ? <div className="mt-2 max-w-md"><Field label="Temporary password" value={form.tempPassword} onChange={(v) => set('tempPassword', v)} required type="text" placeholder="12+ chars: UPPER, lower, number, symbol (e.g. FrnTest-2026!!)" /></div> : null}
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
              <Button type="submit" variant="primary" loading={createMutation.isPending} disabled={createMutation.isPending}>Add staff</Button>
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
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button type="button" variant="secondary" onClick={() => { setMessage(null); setResetMode('email_code'); setResetTempPassword(''); setResetTarget(s); }}>Reset password</Button>
                          <Button type="button" variant="secondary" onClick={() => { setMessage(null); setUnlockEmailConfirm(''); setUnlockTarget(s); }}>Unlock / clear MFA</Button>
                          <Button type="button" variant="ghost" disabled={toggleMutation.isPending} onClick={() => toggleMutation.mutate({ user: s, active: !s.active })}>{s.active ? 'Deactivate' : 'Reactivate'}</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>

        {resetTarget ? (
          <div role="dialog" aria-modal="true" aria-labelledby="reset-pw-title">
            <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" onClick={closeReset} />
            <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-2xl">
              <h2 id="reset-pw-title" className="text-lg font-semibold text-slate-900">Reset password</h2>
              <p className="mt-1 text-sm text-slate-600">For <span className="font-medium text-slate-900">{resetTarget.email}</span>.</p>
              <div className="mt-4 space-y-2 text-sm text-slate-700">
                <label className="flex items-start gap-2">
                  <input type="radio" name="reset-mode" className="mt-1" checked={resetMode === 'email_code'} onChange={() => setResetMode('email_code')} />
                  <span><span className="font-medium text-slate-900">Email a reset code</span> <span className="text-slate-500">(recommended)</span><br /><span className="text-xs text-slate-500">Cognito emails them a code; no password leaves the server.</span></span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" name="reset-mode" className="mt-1" checked={resetMode === 'temp_password'} onChange={() => setResetMode('temp_password')} />
                  <span><span className="font-medium text-slate-900">Set a temporary password</span><br /><span className="text-xs text-slate-500">One-time login; they must change it at next sign-in.</span></span>
                </label>
              </div>
              {resetMode === 'temp_password' ? (
                <label className="mt-3 block">
                  <span className="text-sm font-medium text-slate-800">Temporary password</span>
                  <input type="text" value={resetTempPassword} onChange={(e) => setResetTempPassword(e.target.value)} placeholder="12+ chars: UPPER, lower, number, symbol (e.g. FrnTest-2026!!)" className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200" />
                </label>
              ) : null}
              <div className="mt-6 flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={closeReset}>Cancel</Button>
                <Button type="button" variant="primary" loading={resetMutation.isPending} disabled={resetMutation.isPending || (resetMode === 'temp_password' && !isStrongTempPassword(resetTempPassword))} onClick={submitReset}>{resetMode === 'temp_password' ? 'Set temporary password' : 'Email reset code'}</Button>
              </div>
            </div>
          </div>
        ) : null}

        {unlockTarget ? (
          <div role="dialog" aria-modal="true" aria-labelledby="unlock-mfa-title">
            <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm" onClick={closeUnlock} />
            <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-2xl">
              <h2 id="unlock-mfa-title" className="text-lg font-semibold text-slate-900">Unlock / clear MFA</h2>
              <p className="mt-2 text-sm text-slate-700">This clears <span className="font-medium text-slate-900">{unlockTarget.email}</span>'s MFA factors and re-enables the login. This is account-takeover-grade — anyone who controls their inbox can then sign in.{unlockTarget.roles.includes('admin') ? <span className="font-medium text-rose-700"> This is an ADMIN account.</span> : null}</p>
              <label className="mt-4 block">
                <span className="text-sm font-medium text-slate-800">Type the target email to confirm</span>
                <input type="text" autoComplete="off" value={unlockEmailConfirm} onChange={(e) => setUnlockEmailConfirm(e.target.value)} placeholder={unlockTarget.email} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200" />
              </label>
              <div className="mt-6 flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={closeUnlock}>Cancel</Button>
                <Button type="button" variant="destructive" loading={unlockMutation.isPending} disabled={unlockMutation.isPending || unlockEmailConfirm.trim().toLowerCase() !== unlockTarget.email.toLowerCase()} onClick={() => unlockMutation.mutate(unlockTarget)}>Clear MFA &amp; unlock</Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
