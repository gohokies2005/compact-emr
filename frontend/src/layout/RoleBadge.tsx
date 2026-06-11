import type { Role } from '../types/prisma';
// Human chip labels (P3 identity block, Ryan 2026-06-11): "ops staff" -> "Operations staff",
// title-case the rest. Rendered in the TopNav identity cluster for every role.
const labels: Record<Role, string> = { admin: 'Admin', physician: 'Physician', ops_staff: 'Operations staff' };
export function RoleBadge({ role }: { readonly role: Role }) { return <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{labels[role]}</span>; }
