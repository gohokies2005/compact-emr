import { NavLink } from 'react-router-dom';
import { UserMenu } from './UserMenu';
import { useAuth } from '../auth/useAuth';
import { useHasQueryClient, useInboxUnreadCount } from '../api/messaging';
import type { Role } from '../types/prisma';

const navItems: readonly { label: string; href: string; roles: readonly Role[] }[] = [
  { label: 'Home', href: '/', roles: ['admin', 'ops_staff'] },
  { label: 'Intake', href: '/intake', roles: ['admin', 'ops_staff'] },
  { label: 'Veterans', href: '/veterans', roles: ['admin', 'ops_staff'] },
  { label: 'Cases', href: '/cases', roles: ['admin', 'ops_staff'] },
  { label: 'Inbox', href: '/inbox', roles: ['admin', 'ops_staff', 'physician'] },
  { label: 'Templates', href: '/templates', roles: ['admin'] },
  { label: 'Physicians', href: '/physicians', roles: ['admin'] },
  { label: 'Staff', href: '/staff', roles: ['admin'] },
  { label: 'Email Setup', href: '/email-settings', roles: ['admin'] },
  { label: 'Activity', href: '/activity', roles: ['admin'] },
  { label: 'Refunds', href: '/refunds', roles: ['admin', 'ops_staff'] },
  { label: 'Compensation', href: '/compensation', roles: ['admin'] },
  { label: 'Costs', href: '/costs', roles: ['admin'] },
  { label: 'Metrics', href: '/metrics', roles: ['admin'] },
  { label: 'Queue', href: '/p/queue', roles: ['physician'] },
  { label: 'Letters', href: '/p/letters', roles: ['physician'] }
];
// Badge renders the inbox unread count. Split into its own component (only mounted when a QueryClient
// is present) so the nav — which renders on every page — never crashes a provider-less unit test.
function InboxBadge() {
  const unreadCount = useInboxUnreadCount();
  if (unreadCount <= 0) return null;
  return <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-indigo-600 px-1.5 py-0.5 text-xs font-semibold text-white">{unreadCount}</span>;
}

export function TopNav() {
  const { role } = useAuth();
  const hasClient = useHasQueryClient();
  const visibleItems = role ? navItems.filter((item) => item.roles.includes(role)) : [];
  return <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4"><div className="flex items-center gap-6"><NavLink to="/" className="text-lg font-semibold text-slate-900">Compact EMR</NavLink><nav className="hidden items-center gap-1 md:flex">{visibleItems.map((item) => <NavLink key={item.href} to={item.href} className={({ isActive }) => `relative rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}><span className="inline-flex items-center gap-1.5">{item.label}{item.href === '/inbox' && hasClient ? <InboxBadge /> : null}</span></NavLink>)}</nav></div><UserMenu /></div></header>;
}
