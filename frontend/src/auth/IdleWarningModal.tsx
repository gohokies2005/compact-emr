import { useContext } from 'react';
import { AuthContext } from './AuthProvider';

// Inactivity warning shown ~2 min before the HIPAA idle auto-logout (Ryan 2026-07-10). Reads the
// countdown + `stayActive`/`signOut` from AuthContext (rendered inside AuthProvider). Any real user input
// also dismisses it (AuthProvider resets on activity); this modal gives an explicit choice + a warning so
// a walked-away session doesn't silently drop unsaved work. Renders nothing until the warning window.
export function IdleWarningModal() {
  const ctx = useContext(AuthContext);
  if (!ctx || ctx.idleWarningSecondsLeft === null) return null;
  const secs = ctx.idleWarningSecondsLeft;
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="idle-warn-title" aria-describedby="idle-warn-body">
      <div className="fixed inset-0 z-[60] bg-slate-900/50 backdrop-blur-sm" />
      <div className="fixed left-1/2 top-1/2 z-[61] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-2xl">
        <h2 id="idle-warn-title" className="text-lg font-semibold text-slate-900">Still there?</h2>
        <p id="idle-warn-body" className="mt-2 text-sm text-slate-600">
          For security, you&rsquo;ll be signed out in <span className="font-semibold tabular-nums text-slate-900">{mmss}</span> due to inactivity.
          Any unsaved changes will be lost. Signing back in requires your password and authenticator code.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => { void ctx.signOut(); }}
            className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Log out now
          </button>
          <button
            type="button"
            onClick={ctx.stayActive}
            className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}
