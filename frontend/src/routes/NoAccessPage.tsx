import { Link } from 'react-router-dom';
import { AppShell } from '../layout/AppShell';
import { Button } from '../components/ui/Button';
import { useAuth } from '../auth/useAuth';
export function NoAccessPage() { const { role } = useAuth(); const home = role === 'physician' ? '/p/queue' : role === 'admin' || role === 'ops_staff' ? '/' : '/signin'; return <AppShell><div className="rounded-lg border border-slate-200 bg-white p-8"><h1 className="text-2xl font-semibold text-slate-900">403 — No access</h1><p className="mt-2 text-sm text-slate-500">Your account does not have permission to view this page.</p><Link to={home} className="mt-6 inline-block"><Button>Back to home</Button></Link></div></AppShell>; }
