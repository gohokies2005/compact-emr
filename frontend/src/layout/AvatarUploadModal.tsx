import { useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uploadAndAttachUserAvatar, validateAvatarFile } from '../api/users';

/**
 * Self-service avatar upload, opened by clicking your avatar in the TopNav identity cluster
 * (P3 — Ryan picked the avatar-click modal over a dedicated /profile page). Presign -> PUT ->
 * register via uploadAndAttachUserAvatar; on success the ['users','me'] query is invalidated so
 * the nav re-renders with the fresh presigned avatarUrl.
 */
export function AvatarUploadModal({ userId, onClose }: { readonly userId: string; readonly onClose: () => void }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadAndAttachUserAvatar(userId, file),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['users', 'me'] });
      onClose();
    },
    onError: (error: unknown) => {
      setMessage(error instanceof Error ? error.message : 'Avatar upload failed.');
    },
  });

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const problem = validateAvatarFile(file);
    if (problem !== null) {
      setMessage(problem);
      event.target.value = '';
      return;
    }
    setMessage(null);
    uploadMutation.mutate(file);
    event.target.value = '';
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/40 p-6" onClick={onClose} role="presentation">
      <div
        className="mx-auto mt-24 max-w-sm rounded-lg bg-white p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Change your avatar"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">Change your avatar</h2>
          <button type="button" className="text-slate-400 hover:text-slate-600" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="mt-2 text-sm text-slate-600">PNG, JPEG, or WebP up to 2 MB. Shown next to your name in the top bar.</p>
        <label className="mt-4 inline-flex cursor-pointer items-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
          {uploadMutation.isPending ? 'Uploading…' : 'Choose image'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Choose avatar image"
            className="sr-only"
            onChange={handleFileChange}
            disabled={uploadMutation.isPending}
          />
        </label>
        {message ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{message}</div> : null}
      </div>
    </div>
  );
}
