import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { AppShell } from '../layout/AppShell';
import { PlaceholderCard } from '../components/PlaceholderCard';
import { EmptyState } from '../components/ui/EmptyState';

const cards = [
  ['Today\'s work', 'Coming in Phase 4 — case list filtered to today'],
  ['Open intake', 'Coming in Phase 3 — new-claim flow'],
  ['Physician queue', 'Coming in Phase 4 — assignment summary'],
  ['Refunds queue', 'Coming in Phase 7 — refund list'],
  ['Templates', 'Coming in Phase 4 — template editor'],
  ['Activity', 'Coming in Phase 7 — recent log entries']
] as const;

export function HomePage() {
  const { role } = useAuth();
  if (role === 'physician') return <Navigate to="/p/queue" replace />;
  return <AppShell><div className="mb-8"><h1 className="text-2xl font-semibold text-slate-900">Home</h1><p className="mt-2 text-sm text-slate-500">Phase 2 shell and authenticated navigation.</p></div><div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">{cards.map(([title, hint]) => <PlaceholderCard key={title} title={title} hint={hint} />)}</div><div className="mt-8"><EmptyState title="Welcome to Compact EMR" message="The shell is up. Feature pages roll in over the next few phases." /></div></AppShell>;
}
