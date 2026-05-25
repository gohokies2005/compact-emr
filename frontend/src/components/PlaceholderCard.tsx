import { Card } from './ui/Card';
export function PlaceholderCard({ title, hint }: { readonly title: string; readonly hint: string }) { return <Card><h2 className="text-base font-semibold text-slate-900">{title}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{hint}</p></Card>; }
