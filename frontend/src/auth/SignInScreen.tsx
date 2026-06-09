import { FormEvent, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../components/ui/Button';
import { AegisLogo } from '../components/AegisLogo';
import { BridgeRotation } from '../components/BridgeRotation';
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
    <main className="flex min-h-screen bg-foam">
      {/* Left: sign-in card on a faint oversized navy shield watermark. */}
      <div className="relative flex w-full items-center justify-center overflow-hidden px-6 py-12 lg:w-[46%]">
        <ShieldCheck
          aria-hidden="true"
          className="pointer-events-none absolute -left-24 top-1/2 -translate-y-1/2 text-navy"
          style={{ opacity: 0.045, width: 620, height: 620 }}
          strokeWidth={0.75}
        />
        <section className="relative z-10 w-full max-w-md rounded-[28px] border border-aegis bg-ivory p-9 shadow-aegis-panel">
          <div className="mb-8 flex flex-col items-start gap-5">
            <AegisLogo size="large" wordmark={false} />
            <div>
              <h1 className="text-2xl font-light tracking-[0.35em] text-navyDeep">AEGIS</h1>
              <div className="mt-2 h-[2px] w-14 rounded-full bg-brass" aria-hidden="true" />
              <p className="mt-3 text-sm text-steel">For those who served.</p>
            </div>
          </div>
          {error ? <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
          {challengeStep === 'new_password_required' ? (
            <form onSubmit={onNewPasswordSubmit} className="space-y-4"><Field label="Permanent password" type="password" value={newPassword} onChange={setNewPassword} /><Button className="w-full" loading={submitting}>Set password</Button></form>
          ) : challengeStep === 'mfa_setup' ? (
            <form onSubmit={onTotpSubmit} className="space-y-4"><p className="text-sm text-slate-600">Enroll TOTP in Authy, 1Password, or an authenticator app, then enter the 6-digit code.</p>{totpSetupDetails?.uri ? <div className="flex flex-col items-center gap-3 rounded-md bg-white p-4 border border-slate-200"><QRCodeSVG value={totpSetupDetails.uri} size={192} level="M" /><span className="text-xs text-slate-500">Scan with Authy, 1Password, or Google Authenticator</span></div> : null}{totpSetupDetails?.sharedSecret ? <div className="rounded-md bg-slate-100 p-3 text-sm text-slate-600">Manual key: {totpSetupDetails.sharedSecret}</div> : null}<Field label="6-digit code" value={code} onChange={setCode} /><Button className="w-full" loading={submitting}>Verify TOTP</Button></form>
          ) : challengeStep === 'software_token_mfa' ? (
            <form onSubmit={onMfaSubmit} className="space-y-4"><Field label="6-digit code" value={code} onChange={setCode} /><Button className="w-full" loading={submitting}>Verify</Button></form>
          ) : (
            <form onSubmit={onPasswordSubmit} className="space-y-4"><Field label="Email" type="email" value={email} onChange={setEmail} /><Field label="Password" type="password" value={password} onChange={setPassword} /><Button className="w-full" loading={submitting}>Sign in</Button></form>
          )}
        </section>
      </div>

      {/* Right: serene rotating WA bridge banner with a calm overlay. */}
      <div className="relative hidden lg:block lg:w-[54%]">
        <BridgeRotation>
          <div className="flex h-full w-full flex-col justify-center px-14">
            <div className="max-w-md rounded-2xl bg-slate-950/30 p-8 backdrop-blur-md">
              <h2 className="text-3xl font-light tracking-wide text-white">Calm. Focused. Protected.</h2>
              <div className="mt-4 h-[2px] w-12 rounded-full bg-brass" aria-hidden="true" />
              <p className="mt-4 text-lg font-light leading-relaxed text-white">
                {"We don't just build letters — we build the bridge between service and diagnosis."}
              </p>
              <p className="mt-3 text-sm text-white/70">Built for evidence. Backed by physicians.</p>
            </div>
          </div>
        </BridgeRotation>
      </div>
    </main>
  );
}

function Field({ label, value, onChange, type = 'text' }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly type?: string }) {
  return <label className="block text-sm font-medium text-slate-700">{label}<input className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 shadow-sm focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy" type={type} value={value} onChange={(event) => onChange(event.target.value)} required /></label>;
}
