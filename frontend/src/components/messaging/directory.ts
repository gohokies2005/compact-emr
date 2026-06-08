// Shared sub -> { name, role } directory used to label senders and color message bubbles. Kept in its
// own (non-component) module so MessageBubble.tsx exports only a component (react-refresh-friendly).
export type BubbleRole = 'physician' | 'ops_staff' | 'admin' | 'unknown';

export interface DirectoryEntry {
  readonly name: string;
  readonly role: BubbleRole;
}

export type SubDirectory = Readonly<Record<string, DirectoryEntry>>;

export function roleClassName(role: BubbleRole): string {
  if (role === 'physician') return 'border-purple-200 bg-purple-50 text-purple-800';
  if (role === 'ops_staff') return 'border-blue-200 bg-blue-50 text-blue-800';
  if (role === 'admin') return 'border-slate-200 bg-slate-100 text-slate-700';
  return 'border-slate-200 bg-slate-100 text-slate-600';
}

export function senderLabel(sub: string, directory: SubDirectory): string {
  const entry = directory[sub];
  if (entry?.name) return entry.name;
  return sub;
}
