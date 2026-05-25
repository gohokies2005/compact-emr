import type { Role } from '../types/prisma';
const labels: Record<Role, string> = { admin: 'admin', physician: 'physician', ops_staff: 'ops staff' };
export function RoleBadge({ role }: { readonly role: Role }) { return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{labels[role]}</span>; }
