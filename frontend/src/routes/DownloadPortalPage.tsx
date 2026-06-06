import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { checkDeliveryToken, unlockDelivery } from '../api/delivery-portal';

// PUBLIC, logged-out page at /d/:token — the veteran enters the password from their email to view the
// signed letter PDF (served via a short-lived presigned S3 URL). Self-contained: no AppShell, no auth.
export function DownloadPortalPage() {
  const { token } = useParams();
  const [state, setState] = useState<'loading' | 'valid' | 'invalid' | 'expired'>('loading');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!token) { setState('invalid'); return; }
      const r = await checkDeliveryToken(token);
      if (!active) return;
      setState(r.valid ? 'valid' : r.expired ? 'expired' : 'invalid');
    })();
    return () => { active = false; };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true); setError(null);
    const r = await unlockDelivery(token, password);
    setBusy(false);
    if (r.ok && r.url) { window.location.href = r.url; return; }
    if (!r.ok && r.status === 410) { setState('expired'); return; }
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
          {state === 'valid' ? (
            <form onSubmit={submit} className="mt-4 space-y-3">
              <p className="text-sm text-slate-600">Enter the password from your email to view your letter (PDF).</p>
              <input className="input w-full" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus aria-label="Password" />
              {error ? <p className="text-sm text-rose-600">{error}</p> : null}
              <button type="submit" disabled={busy || !password.trim()} className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
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
