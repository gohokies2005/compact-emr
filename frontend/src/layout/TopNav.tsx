import { NavLink } from 'react-router-dom';
import { UserMenu } from './UserMenu';
import { AegisLogo } from '../components/AegisLogo';
import { useAuth } from '../auth/useAuth';
import { useHasQueryClient, useInboxUnreadCount } from '../api/messaging';
import type { Role } from '../types/prisma';

// STAFF nav only. Physicians never read this array — their ordered nav is physicianNavItems below,
// so physician entries (Queue/Letters, or 'physician' in roles) here would be dead code.
const navItems: readonly { label: string; href: string; roles: readonly Role[] }[] = [
  { label: 'Home', href: '/', roles: ['admin', 'ops_staff'] },
  { label: 'Intake', href: '/intake', roles: ['admin', 'ops_staff'] },
  { label: 'Veterans', href: '/veterans', roles: ['admin', 'ops_staff'] },
  { label: 'Cases', href: '/cases', roles: ['admin', 'ops_staff'] },
  { label: 'Inbox', href: '/inbox', roles: ['admin', 'ops_staff'] },
  { label: 'Templates', href: '/templates', roles: ['admin'] },
  { label: 'Physicians', href: '/physicians', roles: ['admin'] },
  { label: 'Staff', href: '/staff', roles: ['admin'] },
  { label: 'Email Setup', href: '/email-settings', roles: ['admin'] },
  // Refunds dropped from the nav (UI sweep P2c, Ryan item 13) — the refund signal now lives on the
  // case page as a per-chart banner; /refunds stays reachable by URL for admin (App.tsx route).
  { label: 'Activity', href: '/activity', roles: ['admin'] },
  { label: 'Compensation', href: '/compensation', roles: ['admin'] },
  { label: 'Costs', href: '/costs', roles: ['admin'] },
  { label: 'Metrics', href: '/metrics', roles: ['admin'] }
];

// Physicians get a dedicated ordered nav (Ryan 2026-06-10 P2.2; renamed + split 2026-06-11 P4):
// LEFT group "Letters in Queue" (their landing) | "Completed Letters"; Inbox renders RIGHT-aligned
// next to the identity cluster (physicianRightNavItems below). Staff order/layout unchanged.
const physicianNavItems: readonly { label: string; href: string }[] = [
  { label: 'Letters in Queue', href: '/p/queue' },
  { label: 'Completed Letters', href: '/p/letters' }
];
const physicianRightNavItems: readonly { label: string; href: string }[] = [
  { label: 'Inbox', href: '/inbox' }
];
// Badge renders the inbox unread count. Split into its own component (only mounted when a QueryClient
// is present) so the nav — which renders on every page — never crashes a provider-less unit test.
function InboxBadge() {
  const unreadCount = useInboxUnreadCount();
  if (unreadCount <= 0) return null;
  return <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-navy px-1.5 py-0.5 text-xs font-semibold text-white">{unreadCount}</span>;
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `relative rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-mist text-navyDeep' : 'text-steel hover:bg-mistSoft hover:text-navyDeep'}`;

export function TopNav() {
  const { role } = useAuth();
  const hasClient = useHasQueryClient();
  const visibleItems = role === 'physician' ? physicianNavItems : role ? navItems.filter((item) => item.roles.includes(role)) : [];
  const rightItems = role === 'physician' ? physicianRightNavItems : [];
  const renderItem = (item: { label: string; href: string }) => (
    <NavLink key={item.href} to={item.href} className={navLinkClass}>
      <span className="inline-flex items-center gap-1.5">{item.label}{item.href === '/inbox' && hasClient ? <InboxBadge /> : null}</span>
    </NavLink>
  );
  return (
    <header className="border-b border-aegis bg-ivory/95 backdrop-blur-sm shadow-aegis-soft">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-6">
          <NavLink to="/" aria-label="Aegis home" className="shrink-0"><AegisLogo /></NavLink>
          <nav className="hidden items-center gap-1 md:flex">{visibleItems.map(renderItem)}</nav>
        </div>
        <div className="flex items-center gap-4">
          {rightItems.length > 0 ? <div className="hidden items-center gap-1 md:flex">{rightItems.map(renderItem)}</div> : null}
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
