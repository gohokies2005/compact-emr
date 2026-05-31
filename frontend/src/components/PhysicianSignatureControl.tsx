import { ChangeEvent, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/Button';
import { downloadPhysicianSignature, uploadAndAttachPhysicianSignature, type PhysicianPublic } from '../api/physicians';

interface PhysicianSignatureControlProps {
  readonly physician: PhysicianPublic;
}

export function PhysicianSignatureControl({ physician }: PhysicianSignatureControlProps) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadAndAttachPhysicianSignature(physician.id, file),
    onSuccess: async () => { setMessage('Signature uploaded.'); await qc.invalidateQueries({ queryKey: ['physicians'] }); },
    onError: (error: unknown) => { setMessage(error instanceof Error ? error.message : 'Signature upload failed.'); },
  });

  const previewMutation = useMutation({
    mutationFn: () => downloadPhysicianSignature(physician.id),
    onSuccess: (response) => { setPreviewUrl(response.data.downloadUrl); setMessage(null); },
    onError: () => { setMessage('Signature preview could not be loaded.'); },
  });

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type !== 'image/png') { setMessage('Signature must be a PNG file.'); event.target.value = ''; return; }
    uploadMutation.mutate(file);
    event.target.value = '';
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-medium text-slate-900">Signature</div>
          <p className="mt-1 text-sm text-slate-600">PNG only. This signature is used when rendering finalized letters.</p>
          <div className="mt-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${physician.hasSignature ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
              {physician.hasSignature ? 'Signature ready' : 'Missing signature'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
            Upload PNG
            <input type="file" accept="image/png" aria-label="Upload PNG" className="sr-only" onChange={handleFileChange} disabled={uploadMutation.isPending} />
          </label>
          <Button type="button" variant="secondary" disabled={!physician.hasSignature || previewMutation.isPending} loading={previewMutation.isPending} onClick={() => previewMutation.mutate()}>Preview</Button>
        </div>
      </div>

      {uploadMutation.isPending ? <div className="mt-3 text-sm text-slate-500">Uploading signature...</div> : null}
      {message ? <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">{message}</div> : null}
      {previewUrl ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-sm font-medium text-slate-800">Preview</div>
          <img src={previewUrl} alt={`${physician.fullName} signature preview`} className="mt-3 max-h-32 rounded border border-slate-200 bg-white object-contain p-3" />
        </div>
      ) : null}
    </div>
  );
}
