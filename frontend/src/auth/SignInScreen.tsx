import { FormEvent, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useAuth } from './useAuth';

export function SignInScreen() {
  const { signIn, confirmNewPassword, confirmMfaCode, confirmTotpSetup, challengeStep, totpSetupDetails } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(handler: () => Promise<void>) {
    setSubmitting(true);
    setError(null);
    try { await handler(); } catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.'); } finally { setSubmitting(false); }
  }

  function onPasswordSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit(() => signIn(email, password)); }
  function onNewPasswordSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit(() => confirmNewPassword(newPassword)); }
  function onMfaSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit(() => confirmMfaCode(code)); }
  function onTotpSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit(() => confirmTotpSetup(code)); }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-12">
      <section className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-600 text-white"><ShieldCheck size={22} /></div>
          <div><h1 className="text-xl font-semibold text-slate-900">Compact EMR</h1><p className="text-sm text-slate-500">Secure staff sign-in</p></div>
        </div>
        {error ? <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
        {challengeStep === 'new_password_required' ? (
          <form onSubmit={onNewPasswordSubmit} className="space-y-4"><Field label="Permanent password" type="password" value={newPassword} onChange={setNewPassword} /><Button className="w-full" loading={submitting}>Set password</Button></form>
        ) : challengeStep === 'mfa_setup' ? (
          <form onSubmit={onTotpSubmit} className="space-y-4"><p className="text-sm text-slate-600">Enroll TOTP in Authy, 1Password, or an authenticator app, then enter the 6-digit code.</p>{totpSetupDetails?.uri ? <div className="break-all rounded-md bg-slate-100 p-3 text-xs text-slate-600">{totpSetupDetails.uri}</div> : null}{totpSetupDetails?.sharedSecret ? <div className="rounded-md bg-slate-100 p-3 text-sm text-slate-600">Manual key: {totpSetupDetails.sharedSecret}</div> : null}<Field label="6-digit code" value={code} onChange={setCode} /><Button className="w-full" loading={submitting}>Verify TOTP</Button></form>
        ) : challengeStep === 'software_token_mfa' ? (
          <form onSubmit={onMfaSubmit} className="space-y-4"><Field label="6-digit code" value={code} onChange={setCode} /><Button className="w-full" loading={submitting}>Verify</Button></form>
        ) : (
          <form onSubmit={onPasswordSubmit} className="space-y-4"><Field label="Email" type="email" value={email} onChange={setEmail} /><Field label="Password" type="password" value={password} onChange={setPassword} /><Button className="w-full" loading={submitting}>Sign in</Button></form>
        )}
      </section>
    </main>
  );
}

function Field({ label, value, onChange, type = 'text' }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly type?: string }) {
  return <label className="block text-sm font-medium text-slate-700">{label}<input className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 shadow-sm focus:border-indigo-600 focus:outline-none focus:ring-1 focus:ring-indigo-600" type={type} value={value} onChange={(event) => onChange(event.target.value)} required /></label>;
}
