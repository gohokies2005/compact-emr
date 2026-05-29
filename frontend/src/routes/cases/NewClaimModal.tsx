import type { ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '../../components/ui/Button';
import { ConditionSelect } from '../../components/ConditionSelect';
import { ConditionMultiSelect } from '../../components/ConditionMultiSelect';
import type { CreateCaseInput } from '../../api/cases';

const schema = z.object({
  id: z.string().optional(),
  claimedConditions: z.array(z.string().min(1)).min(1, 'At least one condition is required'),
  claimType: z.enum(['initial', 'supplemental', 'hlr', 'appeal_bva']),
  framingChoice: z.string().max(80).optional(),
  upstreamScCondition: z.string().max(200).optional(),
  veteranStatement: z.string().max(2000).optional(),
  inServiceEvent: z.string().max(2000).optional(),
});

type FormValues = z.infer<typeof schema>;

interface Props { readonly open: boolean; readonly onClose: () => void; readonly onSubmit: (input: CreateCaseInput) => Promise<void>; readonly saving: boolean; }

const CLAIM_TYPES: readonly { readonly value: FormValues['claimType']; readonly label: string }[] = [
  { value: 'initial', label: 'Initial' },
  { value: 'supplemental', label: 'Supplemental' },
  { value: 'hlr', label: 'Higher-level review' },
  { value: 'appeal_bva', label: 'Board appeal' },
];

const FRAMING_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: '— Auto (let the drafter decide) —' },
  { value: 'direct', label: 'Direct' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'aggravation', label: 'Aggravation' },
  { value: 'presumptive', label: 'Presumptive' },
];

export function NewClaimModal({ open, onClose, onSubmit, saving }: Props) {
  const { register, handleSubmit, control, formState: { errors } } = useForm<FormValues>({ defaultValues: { claimType: 'initial', claimedConditions: [] } });
  if (!open) return null;

  async function submit(values: FormValues) {
    const parsed = schema.parse(values);
    const input: CreateCaseInput = {
      id: 'CLM-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase(),
      // claimedCondition (singular) = the RN's first pick (primary); claimedConditions = full set.
      claimedCondition: parsed.claimedConditions[0]!,
      claimedConditions: parsed.claimedConditions,
      claimType: parsed.claimType,
      ...(parsed.framingChoice && { framingChoice: parsed.framingChoice }),
      ...(parsed.upstreamScCondition && { upstreamScCondition: parsed.upstreamScCondition }),
      ...(parsed.veteranStatement && { veteranStatement: parsed.veteranStatement }),
      ...(parsed.inServiceEvent && { inServiceEvent: parsed.inServiceEvent }),
    };
    await onSubmit(input);
  }

  return <div className="fixed inset-0 z-50 bg-slate-900/40 p-6"><div className="mx-auto max-h-[calc(100vh-3rem)] max-w-2xl overflow-auto rounded-lg bg-white p-6 shadow-xl">
    <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold text-slate-900">New claim</h2><button type="button" className="text-slate-500" onClick={onClose}>×</button></div>
    <form className="grid grid-cols-1 gap-4 md:grid-cols-2" onSubmit={handleSubmit(submit)}>
      <Field label="Claim type" error={errors.claimType?.message}><select className="input" {...register('claimType')}>{CLAIM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></Field>
      <div className="md:col-span-2"><Field label="Claimed condition(s)" error={errors.claimedConditions?.message}><Controller name="claimedConditions" control={control} rules={{ validate: (v) => (v && v.length > 0) || 'At least one condition is required' }} render={({ field }) => <ConditionMultiSelect label="Claimed condition(s)" value={field.value ?? []} onChange={field.onChange} />} /></Field></div>
      <Field label="Framing (optional)" error={errors.framingChoice?.message}><select className="input" {...register('framingChoice')}>{FRAMING_CHOICES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select></Field>
      <Field label="Upstream SC condition (optional)" error={errors.upstreamScCondition?.message}><Controller name="upstreamScCondition" control={control} render={({ field }) => <ConditionSelect label="Upstream SC condition" value={field.value ?? ''} onChange={field.onChange} placeholder="if secondary to a known SC condition…" />} /></Field>
      <div className="md:col-span-2"><Field label="Veteran's account / statement (optional, paste from intake)" error={errors.veteranStatement?.message}><textarea className="input min-h-24" {...register('veteranStatement')} /></Field></div>
      <div className="md:col-span-2"><Field label="Documented in-service event or exposure (optional)" error={errors.inServiceEvent?.message}><textarea className="input min-h-24" {...register('inServiceEvent')} /></Field></div>
      <div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={saving}>Create claim</Button></div>
    </form>
  </div></div>;
}

function Field({ label, error, children }: { readonly label: string; readonly error?: string | undefined; readonly children: ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block font-medium text-slate-700">{label}</span>{children}{error ? <span className="mt-1 block text-xs text-rose-600">{error}</span> : null}</label>;
}
