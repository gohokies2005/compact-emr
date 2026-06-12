import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { checkDeliveryToken, unlockDelivery, type DeliveryMode } from '../api/delivery-portal';

// PUBLIC, logged-out page at /d/:token — the veteran verifies their identity (date of birth + last
// 4 digits of their phone number; HIPAA APP-1 fix 2026-06-11) to view the signed letter PDF via a
// short-lived presigned S3 URL. Legacy links minted before the fix still show the password form.
// Self-contained: no AppShell, no auth.
export function DownloadPortalPage() {
  const { token } = useParams();
  const [state, setState] = useState<'loading' | 'valid' | 'invalid' | 'expired' | 'locked'>('loading');
  const [mode, setMode] = useState<DeliveryMode>('identity');
  const [password, setPassword] = useState('');
  const [dob, setDob] = useState('');
  const [phoneLast4, setPhoneLast4] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!token) { setState('invalid'); return; }
      const r = await checkDeliveryToken(token);
      if (!active) return;
      if (r.mode) setMode(r.mode);
      setState(r.valid ? 'valid' : r.locked ? 'locked' : r.expired ? 'expired' : 'invalid');
    })();
    return () => { active = false; };
  }, [token]);

  const canSubmit = mode === 'identity'
    ? dob.trim() !== '' && /^\d{4}$/.test(phoneLast4.trim())
    : password.trim() !== '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token || !canSubmit) return;
    setBusy(true); setError(null);
    const input = mode === 'identity'
      ? { dob: dob.trim(), phoneLast4: phoneLast4.trim() }
      : { password };
    const r = await unlockDelivery(token, input);
    setBusy(false);
    if (r.ok && r.url) { window.location.href = r.url; return; }
    if (!r.ok && r.status === 410) { setState('expired'); return; }
    if (!r.ok && r.status === 423) { setState('locked'); setError(r.message); return; }
    setError(r.ok ? 'Could not open the letter.' : r.message);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-md px-6 pt-24">
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900">Your nexus letter</h1>
          {state === 'loading' ? <p className="mt-3 text-sm text-slate-500">Loading…</p> : null}
          {state === 'invalid' ? (
            <p className="mt-3 text-sm text-rose-600">This link isn’t valid. Please check the link in your email, or contact info@flatratenexus.com.</p>
          ) : null}
          {state === 'expired' ? (
            <p className="mt-3 text-sm text-rose-600">This link has expired. Please contact info@flatratenexus.com for a new one.</p>
          ) : null}
          {state === 'locked' ? (
            <p className="mt-3 text-sm text-rose-600">
              {error ?? 'For your security this link is now locked. Reply to your delivery email or write to info@flatratenexus.com and our team will verify your identity and help you download your letter.'}
            </p>
          ) : null}
          {state === 'valid' ? (
            <form onSubmit={submit} className="mt-4 space-y-3">
              {mode === 'identity' ? (
                <>
                  <p className="text-sm text-slate-600">To protect your information, please confirm your identity to view your letter (PDF).</p>
                  <label className="block text-sm text-slate-700">
                    Date of birth
                    <input
                      className="input mt-1 w-full"
                      type="date"
                      value={dob}
                      onChange={(e) => setDob(e.target.value)}
                      autoFocus
                      aria-label="Date of birth"
                    />
                  </label>
                  <label className="block text-sm text-slate-700">
                    Last 4 digits of your phone number
                    <input
                      className="input mt-1 w-full"
                      type="text"
                      inputMode="numeric"
                      pattern="\d{4}"
                      maxLength={4}
                      placeholder="1234"
                      value={phoneLast4}
                      onChange={(e) => setPhoneLast4(e.target.value.replace(/\D/g, ''))}
                      aria-label="Last 4 digits of your phone number"
                    />
                  </label>
                </>
              ) : (
                <>
                  <p className="text-sm text-slate-600">Enter the password from your email to view your letter (PDF).</p>
                  <input className="input w-full" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus aria-label="Password" />
                </>
              )}
              {error ? <p className="text-sm text-rose-600">{error}</p> : null}
              <button type="submit" disabled={busy || !canSubmit} className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                {busy ? 'Unlocking…' : 'View my letter'}
              </button>
            </form>
          ) : null}
          <p className="mt-6 text-xs text-slate-400">Flat Rate Nexus · flatratenexus.com</p>
        </div>
      </div>
    </div>
  );
}
