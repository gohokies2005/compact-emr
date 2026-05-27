import { Link } from 'react-router-dom';
import { Card } from './ui/Card';

interface RnWorkflowChecklistProps {
  readonly veteranId?: string;
  readonly caseId?: string;
}

export function RnWorkflowChecklist({ veteranId, caseId }: RnWorkflowChecklistProps) {
  const veteranTo = veteranId ? `/veterans/${encodeURIComponent(veteranId)}` : '/veterans';
  const caseTo = caseId ? `/cases/${encodeURIComponent(caseId)}` : '/cases';

  const steps: readonly { readonly label: string; readonly to: string }[] = [
    { label: '1. Open veteran chart', to: veteranTo },
    { label: '2. Complete RN file review', to: '/rn' },
    { label: '3. Send to Drafter', to: caseTo },
    { label: '4. Physician review', to: '/p/queue' },
  ];

  return (
    <Card>
      <h2 className="text-base font-semibold text-slate-900">RN workflow</h2>
      <p className="mt-1 text-sm text-slate-500">Follow these steps for each claim.</p>
      <ol className="mt-4 space-y-2 text-sm">
        {steps.map((step) => (
          <li key={step.label}>
            <Link className="text-indigo-600 hover:underline" to={step.to}>
              {step.label}
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}
