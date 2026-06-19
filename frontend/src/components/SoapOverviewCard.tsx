import { useQuery } from '@tanstack/react-query';
import { getSoapOverview } from '../api/case-viability';

// Consolidated calm SOAP-note Overview (Ryan 2026-06-19) — the calm front of the case Overview: one
// short SOAP-style narrative + ONE traffic light. The light is decided deterministically server-side;
// the prose only explains it (the AI narrates, never picks the color). Renders nothing when the picker
// is off / fail-open (the dense panels below remain). Design: 3-designer panel — one card, a slim left
// accent that is the ONLY status color, calm muted tones (sage / honey / clay), generous whitespace.

const LIGHT: Record<'green' | 'amber' | 'red', { rule: string; dot: string; word: string; tint: string }> = {
  green: { rule: 'border-l-[#5E8B7E]', dot: 'bg-[#5E8B7E]', word: 'Ready', tint: 'bg-[#F1F5F2]' },
  amber: { rule: 'border-l-[#C19A5B]', dot: 'bg-[#C19A5B]', word: 'Proceed with caution', tint: 'bg-[#F7F2E8]' },
  red: { rule: 'border-l-[#B0654F]', dot: 'bg-[#B0654F]', word: 'Get / verify records', tint: 'bg-[#F6EDE9]' },
};

export function SoapOverviewCard({ caseId }: { readonly caseId: string }) {
  const q = useQuery({
    queryKey: ['case', caseId, 'soap-overview'],
    queryFn: () => getSoapOverview(caseId),
    enabled: caseId.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  const s = q.data?.data;
  if (q.isLoading && !s) {
    return (
      <div className="mb-4 rounded-lg border border-l-4 border-slate-200 border-l-slate-300 bg-[#FBF8F1] px-5 py-4 text-sm text-slate-500">
        Reading the case and writing the summary… this takes a few moments.
      </div>
    );
  }
  if (!s) return null; // picker off / fail-open — the dense panels render as before
  const L = LIGHT[s.light] ?? LIGHT.amber;
  return (
    <div className={`mb-4 rounded-lg border border-l-4 ${L.rule} border-slate-200 ${L.tint} px-5 py-4`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Case overview</span>
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
          <span className={`inline-block h-2 w-2 rounded-full ${L.dot}`} />
          {L.word}
        </span>
      </div>
      {s.headline ? <p className="mt-2 text-lg font-semibold leading-snug text-slate-900">{s.headline}</p> : null}
      <div className="mt-2 space-y-2 whitespace-pre-line text-[15px] leading-relaxed text-slate-700">{s.soap}</div>
      {s.next_action ? (
        <div className="mt-3 border-t border-[#E5DEC9] pt-2 text-[15px] font-medium text-slate-800">
          <span className="text-[#B08D3C]">→ </span>{s.next_action}
        </div>
      ) : null}
      <div className="mt-2 text-[11px] text-slate-400">AI summary of the case engines. A physician confirms before any letter is signed.</div>
    </div>
  );
}
