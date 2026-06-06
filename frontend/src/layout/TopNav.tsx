import { NavLink } from 'react-router-dom';
import { UserMenu } from './UserMenu';
import { useAuth } from '../auth/useAuth';
import type { Role } from '../types/prisma';

const navItems: readonly { label: string; href: string; roles: readonly Role[] }[] = [
  { label: 'Home', href: '/', roles: ['admin', 'ops_staff'] },
  { label: 'Intake', href: '/intake', roles: ['admin', 'ops_staff'] },
  { label: 'Veterans', href: '/veterans', roles: ['admin', 'ops_staff'] },
  { label: 'Cases', href: '/cases', roles: ['admin', 'ops_staff'] },
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
export function TopNav() { const { role } = useAuth(); const visibleItems = role ? navItems.filter((item) => item.roles.includes(role)) : []; return <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4"><div className="flex items-center gap-6"><NavLink to="/" className="text-lg font-semibold text-slate-900">Compact EMR</NavLink><nav className="hidden items-center gap-1 md:flex">{visibleItems.map((item) => <NavLink key={item.href} to={item.href} className={({ isActive }) => `rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}>{item.label}</NavLink>)}</nav></div><UserMenu /></div></header>; }
