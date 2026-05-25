import type { ReactNode } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '../../components/ui/Button';
import type { CreateVeteranInput } from '../../api/veterans';

const yesNoUnknown = z.enum(['yes', 'no', 'unknown']);
const schema = z.object({
  id: z.string().min(1), firstName: z.string().min(1), lastName: z.string().min(1), dob: z.string().min(1), email: z.string().email(),
  phone: z.string().optional(), address: z.string().optional(), branch: z.string().min(1), serviceStartYear: z.coerce.number().int().min(1900), serviceEndYear: z.coerce.number().int().min(1900),
  combatVeteran: yesNoUnknown, pactArea: yesNoUnknown, teraConceded: yesNoUnknown, heightIn: z.coerce.number().int().positive().optional().or(z.literal('').transform(() => undefined)), weightLb: z.coerce.number().int().positive().optional().or(z.literal('').transform(() => undefined)),
});

type FormValues = z.infer<typeof schema>;

interface Props { readonly open: boolean; readonly onClose: () => void; readonly onSubmit: (input: CreateVeteranInput) => Promise<void>; readonly saving: boolean; }
const branches = ['Army', 'Navy', 'Marines', 'Air Force', 'Coast Guard', 'Space Force'];

export function NewVeteranModal({ open, onClose, onSubmit, saving }: Props) {
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({ defaultValues: { combatVeteran: 'unknown', pactArea: 'unknown', teraConceded: 'unknown', branch: 'Army' } });
  if (!open) return null;
  return <div className="fixed inset-0 z-50 bg-slate-900/40 p-6"><div className="mx-auto max-h-[calc(100vh-3rem)] max-w-2xl overflow-auto rounded-lg bg-white p-6 shadow-xl">
    <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold text-slate-900">New veteran</h2><button className="text-slate-500" onClick={onClose}>×</button></div>
    <form className="grid grid-cols-1 gap-4 md:grid-cols-2" onSubmit={handleSubmit(async (values) => { const parsed = schema.parse(values); await onSubmit(parsed as CreateVeteranInput); })}>
      <Field label="VA file number or internal codename" error={errors.id?.message}><input className="input" {...register('id')} /></Field>
      <Field label="Email" error={errors.email?.message}><input className="input" type="email" {...register('email')} /></Field>
      <Field label="First name" error={errors.firstName?.message}><input className="input" {...register('firstName')} /></Field>
      <Field label="Last name" error={errors.lastName?.message}><input className="input" {...register('lastName')} /></Field>
      <Field label="DOB" error={errors.dob?.message}><input className="input" type="date" {...register('dob')} /></Field>
      <Field label="Branch" error={errors.branch?.message}><select className="input" {...register('branch')}>{branches.map((b) => <option key={b}>{b}</option>)}</select></Field>
      <Field label="Service start year" error={errors.serviceStartYear?.message}><input className="input" type="number" {...register('serviceStartYear')} /></Field>
      <Field label="Service end year" error={errors.serviceEndYear?.message}><input className="input" type="number" {...register('serviceEndYear')} /></Field>
      <Field label="Phone"><input className="input" {...register('phone')} /></Field>
      <Field label="Address"><textarea className="input min-h-20" {...register('address')} /></Field>
      <Field label="Combat veteran"><RadioGroup register={register('combatVeteran')} /></Field>
      <Field label="PACT area"><RadioGroup register={register('pactArea')} /></Field>
      <Field label="Known TERA concession"><RadioGroup register={register('teraConceded')} /></Field>
      <Field label="Height in"><input className="input" type="number" {...register('heightIn')} /></Field>
      <Field label="Weight lb"><input className="input" type="number" {...register('weightLb')} /></Field>
      <div className="md:col-span-2 flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={saving}>Create veteran</Button></div>
    </form>
  </div></div>;
}

function Field({ label, error, children }: { readonly label: string; readonly error?: string | undefined; readonly children: ReactNode }) { return <label className="block text-sm"><span className="mb-1 block font-medium text-slate-700">{label}</span>{children}{error ? <span className="mt-1 block text-xs text-rose-600">{error}</span> : null}</label>; }
function RadioGroup({ register }: { readonly register: UseFormRegisterReturn }) { return <div className="flex gap-3 text-sm text-slate-700"><label><input type="radio" value="yes" {...register} /> Yes</label><label><input type="radio" value="no" {...register} /> No</label><label><input type="radio" value="unknown" {...register} /> Unknown</label></div>; }
